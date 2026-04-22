/**
 * Server-side helpers for the /explorer/token/[addr] pages.
 *
 * Kept separate from lib/explorer.ts because token-specific concerns (ERC-20
 * probe, Transfer-log scanning, unique-holder counting) don't belong in the
 * generic address/tx/block toolbelt. Everything here is server-only.
 */
import {
  getAddress,
  parseAbiItem,
  formatUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { abis } from '@etica-hub/shared';
import {
  fetchIndexedAddressTransfers,
  type IndexedTransferRow,
} from './explorerIndex';

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

export interface AddressTokenTransfer {
  /** ERC-20 contract emitting the Transfer event. */
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Scans the last `TOKEN_LOG_SCAN_BLOCKS` blocks for ERC-20 Transfer events
 * where `address` is either the sender or recipient, across ALL token
 * contracts (not a specific token). Two `eth_getLogs` calls fan out in
 * parallel — one for outbound (`from = address`), one for inbound (`to =
 * address`) — then results are merged, deduped on `(txHash, logIndex)`,
 * sorted newest-first, and trimmed to the page size.
 *
 * We use viem's typed `event + args` form, which produces decoded
 * `args.from` / `args.to` / `args.value` on each returned log. A missing
 * or malformed arg on a particular log skips that entry rather than
 * failing the whole scan. RPC failure degrades to an empty list so the
 * page still renders ("no recent transfers found").
 */
export async function scanAddressTokenTransfers(
  client: PublicClient,
  address: Address,
  head: bigint,
  /**
   * Optional override for the scan start block. Defaults to
   * `head - TOKEN_LOG_SCAN_BLOCKS` for standalone use; the indexer-
   * backed path passes a small tail window (~200 blocks) so the RPC
   * call only covers what the cron hasn't indexed yet.
   */
  fromBlockOverride?: bigint,
): Promise<AddressTokenTransfer[]> {
  const fromBlock =
    fromBlockOverride ??
    (head > TOKEN_LOG_SCAN_BLOCKS ? head - TOKEN_LOG_SCAN_BLOCKS : 0n);
  try {
    const [outbound, inbound] = await Promise.all([
      client.getLogs({
        event: TRANSFER_EVENT,
        args: { from: address },
        fromBlock,
        toBlock: head,
      }),
      client.getLogs({
        event: TRANSFER_EVENT,
        args: { to: address },
        fromBlock,
        toBlock: head,
      }),
    ]);
    const seen = new Set<string>();
    const out: AddressTokenTransfer[] = [];
    for (const l of [...outbound, ...inbound]) {
      if (!l.transactionHash || l.blockNumber == null) continue;
      const { from, to, value } = l.args ?? {};
      if (!from || !to || value == null) continue;
      const key = `${l.transactionHash}:${l.logIndex ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        token: l.address as Address,
        from: from as Address,
        to: to as Address,
        value: value as bigint,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex ?? 0,
      });
    }
    out.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? 1 : -1;
      }
      return b.logIndex - a.logIndex;
    });
    return out.slice(0, TOKEN_TRANSFERS_PAGE);
  } catch {
    return [];
  }
}

/**
 * Hard upper bound on the RPC tail-scan window. The tail scan normally
 * starts at `cursor.lastBlock + 1` so it covers exactly the gap
 * between the indexer and head; this constant caps how far back we're
 * willing to RPC-scan if the indexer has fallen badly behind (e.g. the
 * cron was down for hours). Matches `TOKEN_LOG_SCAN_BLOCKS` so worst-
 * case behavior is identical to the pre-indexer RPC-only path.
 */
export const MAX_TAIL_SCAN_BLOCKS = TOKEN_LOG_SCAN_BLOCKS;

/**
 * Indexer-backed variant of {@link scanAddressTokenTransfers}.
 *
 * Strategy:
 *   1. Try to read the indexer's `data-index` branch for `address`.
 *      Returns rows from potentially weeks of history, not just the
 *      last 5000 blocks.
 *   2. Scan the blocks between the indexer cursor and `head` via RPC
 *      to cover what the cron hasn't indexed yet. Capped by
 *      `MAX_TAIL_SCAN_BLOCKS` to protect against unbounded scans when
 *      the indexer has fallen behind (cron outage). Deduped against
 *      the indexed rows on `(txHash, logIndex)`.
 *   3. If the indexer is unavailable (data branch missing, network
 *      error, etc.), fall back to the existing RPC-only scan so the
 *      UI still renders. This means shipping this code is safe even
 *      before the cron has produced any data.
 *
 * Returns at most {@link TOKEN_TRANSFERS_PAGE} rows newest-first. The
 * shape matches `scanAddressTokenTransfers` so callers upgrade with a
 * single-line rename.
 */
export async function loadAddressTokenTransfers(
  client: PublicClient,
  address: Address,
  head: bigint,
): Promise<AddressTokenTransfer[]> {
  const indexed = await fetchIndexedAddressTransfers({
    address: address.toLowerCase(),
  });
  if (!indexed) {
    return scanAddressTokenTransfers(client, address, head);
  }
  // Wrap the indexer-backed path in try/catch so malformed rows (e.g.
  // a bad `block`/`value`/`token` field that slips past parseJsonl)
  // never crash the address page. Every other data-fetching function
  // in this file degrades gracefully the same way; we fall back to
  // the RPC-only scan on any post-parse failure so the UI still
  // renders with the last-5000-blocks window.
  try {
    // Start the RPC tail scan at one block past the indexer cursor so
    // we cover exactly the gap between the last cron tick and head.
    // If the indexer has fallen badly behind (cron outage), cap the
    // scan at MAX_TAIL_SCAN_BLOCKS so we never do an unbounded RPC
    // call — worst case matches the old pre-indexer RPC-only window.
    const cursorBlock = BigInt(indexed.cursor.lastBlock);
    const resumeFrom = cursorBlock + 1n;
    const windowFloor =
      head > MAX_TAIL_SCAN_BLOCKS ? head - MAX_TAIL_SCAN_BLOCKS : 0n;
    const tailFrom = resumeFrom > windowFloor ? resumeFrom : windowFloor;
    const tail = await scanAddressTokenTransfers(client, address, head, tailFrom);

    const seen = new Set<string>();
    const merged: AddressTokenTransfer[] = [];
    for (const t of tail) {
      const key = `${t.txHash.toLowerCase()}:${t.logIndex}`;
      seen.add(key);
      merged.push(t);
    }
    for (const r of indexed.rows) {
      // Lowercase the tx hash to match the tail-side key format: if a
      // future indexer write path ever emits mixed-case hashes, we'd
      // otherwise silently double-render rows already present in the
      // tail-window scan.
      const key = `${r.tx.toLowerCase()}:${r.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(indexedToAddressTransfer(r));
    }
    merged.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? 1 : -1;
      }
      return b.logIndex - a.logIndex;
    });
    return merged.slice(0, TOKEN_TRANSFERS_PAGE);
  } catch {
    return scanAddressTokenTransfers(client, address, head);
  }
}

function indexedToAddressTransfer(r: IndexedTransferRow): AddressTokenTransfer {
  return {
    token: getAddress(r.token),
    from: getAddress(r.from),
    to: getAddress(r.to),
    value: BigInt(r.value),
    txHash: r.tx as `0x${string}`,
    blockNumber: BigInt(r.block),
    logIndex: r.logIndex,
  };
}

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

/**
 * Batch-resolves `{symbol, decimals}` for a list of ERC-20 token addresses.
 * De-duplicates by checksum address so every unique token triggers at most
 * one parallel metadata probe. Tokens that fail to probe (non-ERC-20 or
 * RPC error) are omitted from the returned map — callers should render a
 * neutral fallback (e.g. shortened address) when a lookup is missing.
 */
export async function resolveTokenInfos(
  client: PublicClient,
  addresses: ReadonlyArray<Address>,
): Promise<Map<string, TokenInfo>> {
  const unique = new Set<string>();
  for (const a of addresses) unique.add(a.toLowerCase());
  const entries = await Promise.all(
    Array.from(unique).map(async (lower) => {
      const a = getAddress(lower);
      const meta = await readTokenMetadata(client, a);
      if (!meta) return null;
      return [lower, { symbol: meta.symbol, decimals: meta.decimals }] as const;
    }),
  );
  const map = new Map<string, TokenInfo>();
  for (const e of entries) {
    if (e) map.set(e[0], e[1]);
  }
  return map;
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
