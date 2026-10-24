/**
 * Client for the self-hosted full-chain index (apps/explorer-api on the
 * droplet, Etherscan-compatible `?module=&action=`). Every helper returns
 * `null` when the index is unreachable so pages can fall back to the
 * request-time RPC scan instead of failing.
 */
import 'server-only';

const HUB_API_URL = (process.env.EXPLORER_HUB_API_URL ?? 'http://104.248.193.164/hub').replace(
  /\/$/,
  '',
);
const TIMEOUT_MS = 6_000;

export interface HubTx {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  contractAddress: `0x${string}` | null;
  value: bigint;
  blockNumber: bigint;
  timestamp: bigint;
  isError: boolean;
  methodId: string;
}

export interface HubHolder {
  address: `0x${string}`;
  quantity: bigint;
}

export interface HubIndexerStatus {
  head: number;
  updatedAt: number | null;
}

interface Envelope<T> {
  status: '0' | '1';
  message: string;
  result: T;
}

export async function hubQuery<T>(params: Record<string, string>): Promise<Envelope<T> | null> {
  const url = `${HUB_API_URL}/api?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, next: { revalidate: 15 } });
    if (!res.ok) return null;
    return (await res.json()) as Envelope<T>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function hubIndexerStatus(): Promise<HubIndexerStatus | null> {
  const r = await hubQuery<{ head: string | null; updatedAt: string | null }>({
    module: 'stats',
    action: 'indexer',
  });
  if (!r || r.status !== '1' || r.result.head == null) return null;
  return {
    head: Number(r.result.head),
    updatedAt: r.result.updatedAt ? Date.parse(r.result.updatedAt) / 1000 : null,
  };
}

/** Full address history (newest first); null when the index is unavailable. */
export async function hubAddressTxs(
  address: string,
  page = 1,
  offset = 50,
): Promise<{ txs: HubTx[]; total: number | null } | null> {
  const [list, count] = await Promise.all([
    hubQuery<Array<Record<string, string>>>({
      module: 'account',
      action: 'txlist',
      address,
      page: String(page),
      offset: String(offset),
      sort: 'desc',
    }),
    hubQuery<{ count: string }>({ module: 'account', action: 'txcount', address }),
  ]);
  if (!list) return null;
  const rows = list.status === '1' ? list.result : [];
  return {
    total: count?.status === '1' ? Number(count.result.count) : null,
    txs: rows.map((r) => ({
      hash: r.hash as `0x${string}`,
      from: r.from as `0x${string}`,
      to: r.to ? (r.to as `0x${string}`) : null,
      contractAddress: r.contractAddress ? (r.contractAddress as `0x${string}`) : null,
      value: BigInt(r.value || '0'),
      blockNumber: BigInt(r.blockNumber),
      timestamp: BigInt(r.timeStamp),
      isError: r.isError === '1',
      methodId: r.methodId ?? '',
    })),
  };
}

/** Top holders by indexed balance (ERC-20 Transfer deltas since the index start). */
export async function hubTokenHolders(
  token: string,
  offset = 25,
): Promise<{ holders: HubHolder[]; count: number | null } | null> {
  const [list, count] = await Promise.all([
    hubQuery<Array<{ TokenHolderAddress: string; TokenHolderQuantity: string }>>({
      module: 'token',
      action: 'tokenholderlist',
      contractaddress: token,
      page: '1',
      offset: String(offset),
    }),
    hubQuery<string>({ module: 'token', action: 'tokenholdercount', contractaddress: token }),
  ]);
  if (!list || list.status !== '1') return null;
  return {
    count: count?.status === '1' ? Number(count.result) : null,
    holders: list.result.map((h) => ({
      address: h.TokenHolderAddress as `0x${string}`,
      quantity: BigInt(h.TokenHolderQuantity),
    })),
  };
}
