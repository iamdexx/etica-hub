/**
 * Recipient gas drop for the Etica leg.
 *
 * A wallet that has only ever received USDC.e through the bridge holds no
 * EGAZ and cannot move it. After each run the keeper scans the synthetic
 * router's `ReceivedTransferRemote` events (the router itself emits them
 * from `_handle`, i.e. only after the Mailbox + ISM accepted the message —
 * nothing user-supplied reaches this code) and sends a small EGAZ stipend to
 * recipients that still hold less than `threshold`.
 *
 * Idempotency is balance-based rather than cursor-based: a dropped wallet is
 * above the threshold afterwards, so re-scanning the same window on the next
 * hourly run (GitHub Actions is stateless) never pays twice. Abuse is bounded
 * by `maxPerRun`, the keeper's own gas floor, and the fact that a qualifying
 * transfer pays far more in bridge fees than the drop is worth.
 */

import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import type { GasDropConfig } from './config.js';

export const RECEIVED_TRANSFER_REMOTE = parseAbiItem(
  'event ReceivedTransferRemote(uint32 indexed origin, bytes32 indexed recipient, uint256 amountOrId)',
);

/** Blocks held back from the chain head before trusting an event. */
export const REORG_SAFETY_BLOCKS = 3n;

export interface InboundTransfer {
  recipient: Address;
  amount: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

export interface GasDropPlan {
  drops: Address[];
  skipped: { recipient: Address; reason: string }[];
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Hyperlane encodes EVM recipients as left-padded bytes32; anything else is not a wallet we can pay. */
export function bytes32ToAddress(b: Hex): Address | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(b)) return null;
  if (!/^0x0{24}/.test(b)) return null;
  return `0x${b.slice(26)}` as Address;
}

export function planGasDrops(
  transfers: InboundTransfer[],
  balances: ReadonlyMap<string, bigint>,
  keeper: Address,
  keeperNative: bigint,
  keeperFloor: bigint,
  cfg: GasDropConfig,
): GasDropPlan {
  const drops: Address[] = [];
  const skipped: GasDropPlan['skipped'] = [];
  const seen = new Set<string>();
  let budget = keeperNative > keeperFloor ? keeperNative - keeperFloor : 0n;

  for (const t of transfers) {
    const key = t.recipient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.recipient === ZERO || key === keeper.toLowerCase()) {
      skipped.push({ recipient: t.recipient, reason: 'not a user wallet' });
      continue;
    }
    if (t.amount < cfg.minTransfer) {
      skipped.push({ recipient: t.recipient, reason: `transfer ${t.amount} below minimum` });
      continue;
    }
    const bal = balances.get(key);
    if (bal === undefined) {
      skipped.push({ recipient: t.recipient, reason: 'balance unknown' });
      continue;
    }
    if (bal >= cfg.threshold) {
      skipped.push({ recipient: t.recipient, reason: 'already has gas' });
      continue;
    }
    if (drops.length >= cfg.maxPerRun) {
      skipped.push({ recipient: t.recipient, reason: 'per-run cap reached' });
      continue;
    }
    if (budget < cfg.amount) {
      skipped.push({ recipient: t.recipient, reason: 'keeper would fall below its gas floor' });
      continue;
    }
    budget -= cfg.amount;
    drops.push(t.recipient);
  }
  return { drops, skipped };
}

/**
 * Largest `eth_getLogs` block span requested at once. Public endpoints cap
 * ranges anywhere from 10 to 10k blocks; a run that exceeds a cap errors
 * out (and the scan fails closed) instead of returning a truncated set, so
 * stay well under the common limits.
 */
export const LOG_CHUNK_BLOCKS = 200n;

export async function fetchInboundTransfers(
  client: PublicClient,
  router: Address,
  lookbackBlocks: bigint,
  chunk: bigint = LOG_CHUNK_BLOCKS,
): Promise<{ transfers: InboundTransfer[]; fromBlock: bigint; toBlock: bigint }> {
  if (chunk <= 0n) throw new Error('log chunk must be positive');
  const head = await client.getBlockNumber();
  const toBlock = head > REORG_SAFETY_BLOCKS ? head - REORG_SAFETY_BLOCKS : 0n;
  const fromBlock = toBlock > lookbackBlocks ? toBlock - lookbackBlocks : 0n;
  const logs: Awaited<ReturnType<typeof fetchChunk>> = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    logs.push(...(await fetchChunk(client, router, start, end)));
  }
  const transfers: InboundTransfer[] = [];
  for (const log of logs) {
    const recipient = log.args.recipient ? bytes32ToAddress(log.args.recipient) : null;
    if (!recipient || log.args.amountOrId === undefined || log.blockNumber === null || log.transactionHash === null) continue;
    transfers.push({ recipient, amount: log.args.amountOrId, blockNumber: log.blockNumber, txHash: log.transactionHash });
  }
  return { transfers, fromBlock, toBlock };
}

function fetchChunk(client: PublicClient, router: Address, fromBlock: bigint, toBlock: bigint) {
  return client.getLogs({ address: router, event: RECEIVED_TRANSFER_REMOTE, fromBlock, toBlock });
}
