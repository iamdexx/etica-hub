import type { Log } from 'viem';

export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

export interface TransferRow {
  logIndex: number;
  tx: string;
  token: string;
  from: string;
  to: string;
  value: bigint;
  tokenId: bigint | null;
}

export function topicToAddress(topic: `0x${string}`): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/** ERC-20 (3 topics + 32-byte data) and ERC-721 (4 topics, empty data) Transfer logs. */
export function decodeTransfer(
  log: Pick<Log, 'topics' | 'data' | 'address' | 'logIndex' | 'transactionHash'>,
): TransferRow | null {
  if (
    log.topics[0] !== TRANSFER_TOPIC0 ||
    log.topics.length < 3 ||
    log.logIndex == null ||
    !log.transactionHash
  )
    return null;
  const base = {
    logIndex: log.logIndex,
    tx: log.transactionHash.toLowerCase(),
    token: log.address.toLowerCase(),
    from: topicToAddress(log.topics[1]!),
    to: topicToAddress(log.topics[2]!),
  };
  if (log.topics.length === 3 && log.data.length === 66)
    return { ...base, value: BigInt(log.data), tokenId: null };
  if (log.topics.length === 4 && (log.data === '0x' || log.data.length === 2)) {
    return { ...base, value: 1n, tokenId: BigInt(log.topics[3]!) };
  }
  return null;
}

export function isMint(row: TransferRow): boolean {
  return row.from === ZERO;
}
export function isBurn(row: TransferRow): boolean {
  return row.to === ZERO;
}
export { ZERO };
