/**
 * Log-scanning helpers for the explorer indexer. Pure functions over
 * viem `Log` shape — the run loop handles RPC plumbing.
 */
import { getAddress } from 'viem';
import type { Log } from 'viem';
import type { SyncRow, TransferRow } from './types.js';
import { SYNC_TOPIC0, TRANSFER_TOPIC0 } from './types.js';

/** 0x0000000000000000000000000000000000000000 as lowercase. */
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Decodes a 32-byte topic into a 20-byte ethereum address in lowercase
 * 0x form. No checksum; we explicitly want a consistent canonical form
 * for indexer joins.
 */
function topicToAddress(topic: `0x${string}`): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * Turns an ERC-20 `Transfer` log into a `TransferRow`. Returns `null`
 * for logs that don't match the Transfer shape (wrong topic0, wrong
 * arity, malformed data). That happens occasionally because any
 * contract can emit a topic matching `TRANSFER_TOPIC0`; we only keep
 * the ones that parse as real ERC-20 transfers.
 */
export function decodeTransfer(
  log: Log,
  blockTimestamp: number,
): TransferRow | null {
  if (log.topics[0] !== TRANSFER_TOPIC0) return null;
  if (log.topics.length !== 3) return null;
  if (log.blockNumber == null || log.logIndex == null || log.transactionHash == null) {
    return null;
  }
  const from = topicToAddress(log.topics[1]!);
  const to = topicToAddress(log.topics[2]!);
  // ERC-20 transfers have a single uint256 value in `data`. 66 chars
  // = "0x" + 64 hex. Anything else is a different event shape (e.g. an
  // ERC-1155 TransferSingle).
  if (log.data.length !== 66) return null;
  const value = BigInt(log.data).toString();
  return {
    block: Number(log.blockNumber),
    ts: blockTimestamp,
    tx: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    token: log.address.toLowerCase(),
    from,
    to,
    value,
  };
}

/**
 * Turns a UniswapV2 `Sync(uint112,uint112)` log into a `SyncRow`.
 */
export function decodeSync(log: Log, blockTimestamp: number): SyncRow | null {
  if (log.topics[0] !== SYNC_TOPIC0) return null;
  if (log.blockNumber == null || log.logIndex == null || log.transactionHash == null) {
    return null;
  }
  // data = abi.encode(uint112 reserve0, uint112 reserve1) — padded to
  // 32 bytes each. Total payload: "0x" + 64 + 64 = 130 chars.
  if (log.data.length !== 130) return null;
  const hex = log.data.slice(2);
  const r0 = BigInt(`0x${hex.slice(0, 64)}`);
  const r1 = BigInt(`0x${hex.slice(64, 128)}`);
  return {
    block: Number(log.blockNumber),
    ts: blockTimestamp,
    tx: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    pair: log.address.toLowerCase(),
    reserve0: r0.toString(),
    reserve1: r1.toString(),
  };
}

/**
 * Returns the canonical checksum address of a hex address. Thin
 * wrapper around viem's `getAddress`; kept here so tests have a single
 * import surface.
 */
export { getAddress as checksumAddress };
export { ZERO as ZERO_ADDRESS };
