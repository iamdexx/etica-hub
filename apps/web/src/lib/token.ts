/**
 * Server-side helpers for the /explorer/token/[addr] pages.
 *
 * Kept separate from lib/explorer.ts because token-specific concerns (ERC-20
 * probe, Transfer-log scanning, unique-holder counting) don't belong in the
 * generic address/tx/block toolbelt. Everything here is server-only.
 */
import {
  parseAbiItem,
  formatUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { abis } from '@etica-hub/shared';

/**
 * Width of the Transfer-log scan window for the token detail page. Same
 * rationale as the recent-tx scan on address pages: a bounded range keeps
 * worst-case RPC cost predictable without an indexer.
 *
 * Chose 5000 instead of the 200-block window used for native txs because
 * token transfers are typically much sparser — a 200-block window on a
 * low-volume token would routinely show zero transfers. 5000 is still well
 * under eth_getLogs limits on Eticascan's RPC (10_000).
 */
export const TOKEN_LOG_SCAN_BLOCKS = 5000n;

/** Max number of transfers we render in the recent-transfers list. */
export const TOKEN_TRANSFERS_PAGE = 25;

/** viem-style Transfer event descriptor, reused by getLogs + decodeEventLog. */
export const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
}

/**
 * Best-effort ERC-20 probe. Reads `name` / `symbol` / `decimals` /
 * `totalSupply` in parallel and returns null if ANY of the required calls
 * revert. We deliberately do not fall back to sniffing bytecode — this
 * overload handles the long-tail "EIP-20 but returns bytes32 instead of
 * string" case too crudely to be reliable.
 */
export async function readTokenMetadata(
  client: PublicClient,
  address: Address,
): Promise<TokenMetadata | null> {
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      client.readContract({
        abi: abis.erc20Abi,
        address,
        functionName: 'name',
      }) as Promise<string>,
      client.readContract({
        abi: abis.erc20Abi,
        address,
        functionName: 'symbol',
      }) as Promise<string>,
      client.readContract({
        abi: abis.erc20Abi,
        address,
        functionName: 'decimals',
      }) as Promise<number>,
      client.readContract({
        abi: abis.erc20Abi,
        address,
        functionName: 'totalSupply',
      }) as Promise<bigint>,
    ]);
    // Defensive shape checks — a contract that implements *some* of the
    // ERC-20 interface but returns weird types (e.g. bytes32 name) will
    // type-assert past viem's reads but fail here. Treat as non-ERC-20.
    if (
      typeof name !== 'string' ||
      typeof symbol !== 'string' ||
      typeof decimals !== 'number' ||
      typeof totalSupply !== 'bigint'
    ) {
      return null;
    }
    return { name, symbol, decimals, totalSupply };
  } catch {
    return null;
  }
}

export interface TokenTransfer {
  from: Address;
  to: Address;
  value: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Returns the most recent Transfer events for `address`, newest first,
 * capped at `TOKEN_TRANSFERS_PAGE` after the window scan.
 *
 * One eth_getLogs call scans the window; subsequent work is pure decoding
 * in memory. A missing/failing RPC call degrades to an empty list so the
 * page still renders with "no recent transfers found in last N blocks".
 */
export async function scanRecentTransfers(
  client: PublicClient,
  address: Address,
  head: bigint,
): Promise<TokenTransfer[]> {
  const fromBlock =
    head > TOKEN_LOG_SCAN_BLOCKS ? head - TOKEN_LOG_SCAN_BLOCKS : 0n;
  try {
    const logs = await client.getLogs({
      address,
      event: TRANSFER_EVENT,
      fromBlock,
      toBlock: head,
    });
    // Sort newest first. `getLogs` returns ascending block order on most
    // RPCs but that's not guaranteed across implementations, so normalize.
    const sorted = logs
      .filter((l) => l.args.from && l.args.to && l.args.value != null)
      .sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber! < b.blockNumber! ? 1 : -1;
        }
        return (b.logIndex ?? 0) - (a.logIndex ?? 0);
      })
      .slice(0, TOKEN_TRANSFERS_PAGE);
    return sorted.map((l) => ({
      from: l.args.from as Address,
      to: l.args.to as Address,
      value: l.args.value as bigint,
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!,
      logIndex: l.logIndex ?? 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Formats a raw token amount using its declared decimals. Renders up to
 * 6 fractional digits with trailing zeros stripped — same convention as
 * `formatEgaz` on the explorer-wide helper. A decimals value out of the
 * ERC-20 range (0–77) falls back to raw integer rendering.
 */
export function formatTokenAmount(value: bigint, decimals: number): string {
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 77) {
    return value.toString();
  }
  if (decimals === 0) return value.toString();
  const full = formatUnits(value, decimals);
  const [int, frac = ''] = full.split('.');
  const shortFrac = frac.slice(0, 6).replace(/0+$/, '');
  return shortFrac ? `${int}.${shortFrac}` : int;
}

/**
 * Estimates the unique-holders count from the recent transfer window.
 * Strictly a lower bound — a holder who never transferred in the window
 * is invisible here, and a transferring-zero-balance recipient gets
 * counted as a holder. Good enough for a "recent activity" signal;
 * accurate counts require an indexer.
 */
export function uniqueAddressesFromTransfers(
  transfers: ReadonlyArray<TokenTransfer>,
): number {
  const set = new Set<string>();
  const ZERO = '0x0000000000000000000000000000000000000000';
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from !== ZERO) set.add(from);
    if (to !== ZERO) set.add(to);
  }
  return set.size;
}
