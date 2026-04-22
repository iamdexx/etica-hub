/**
 * Read-side adapter for the explorer indexer's JSONL data.
 *
 * The indexer (apps/indexer, `INDEXER_MODULE=explorer`) commits
 * day-partitioned JSONL to an orphan `data-index` branch every ~10
 * minutes. This module fetches those files via raw.githubusercontent
 * .com, with Next's fetch cache keeping reads cheap.
 *
 * All functions here are read-only and degrade gracefully: if the data
 * branch is missing, stale, or partially populated, they return null
 * and callers should fall back to the direct-RPC path. That means
 * shipping this code to production is safe even before the cron has
 * produced any data — nothing breaks, the UI keeps using its existing
 * RPC scan until the indexer starts filling in.
 */

/**
 * GitHub repo whose `data-index` branch hosts the indexed JSONL. These
 * are hardcoded rather than env-var-driven because the explorer is
 * tied to a single project (iamdexx/etica-hub) — changing this would
 * be a substantial architectural move, not a configuration tweak.
 */
const INDEX_OWNER = 'iamdexx';
const INDEX_REPO = 'etica-hub';
const INDEX_BRANCH = 'data-index';

const RAW_BASE = `https://raw.githubusercontent.com/${INDEX_OWNER}/${INDEX_REPO}/${INDEX_BRANCH}`;

/**
 * How many day-partitions we probe in parallel when looking for a
 * given address's transfer history. 30 is plenty for the current
 * explorer (which only displays the last ~25 transfers per address);
 * raise if we want the page to show deeper history.
 */
const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Seconds to cache each raw.githubusercontent.com response. The cron
 * commits once per ~10 minutes, so a 60s cache still surfaces new
 * data within a minute of the commit but keeps us from hammering
 * GitHub on bursty requests.
 */
const FETCH_REVALIDATE_SECONDS = 60;

export interface IndexedCursor {
  lastBlock: number;
  chainId: number;
  updatedAt: string;
  runs: number;
  cumulative: {
    transfers: number;
    syncs: number;
  };
}

export interface IndexedTransferRow {
  block: number;
  ts: number;
  tx: string;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: string;
}

export interface IndexedSyncRow {
  block: number;
  ts: number;
  tx: string;
  logIndex: number;
  pair: string;
  reserve0: string;
  reserve1: string;
}

/**
 * Fetches the indexer's cursor file. Returns null if the data branch
 * doesn't exist yet (first-run case before the workflow has run).
 */
export async function fetchIndexedCursor(): Promise<IndexedCursor | null> {
  try {
    const res = await fetch(`${RAW_BASE}/cursor.json`, {
      next: { revalidate: FETCH_REVALIDATE_SECONDS },
    });
    if (!res.ok) return null;
    return (await res.json()) as IndexedCursor;
  } catch {
    return null;
  }
}

/**
 * Builds the list of `YYYY/MM/DD` partition keys to probe, walking
 * backwards from today. Pure — no IO, safe to unit-test.
 */
export function recentPartitionKeys(
  today: Date,
  days: number = DEFAULT_LOOKBACK_DAYS,
): string[] {
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const yyyy = d.getUTCFullYear().toString();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    keys.push(`${yyyy}/${mm}/${dd}`);
  }
  return keys;
}

/**
 * Parses a JSONL body into rows, silently skipping malformed lines.
 * The indexer emits one JSON object per line with no trailing commas,
 * so the only realistic failure is a truncated line from a partial
 * push (in which case dropping it is the right call).
 */
export function parseJsonl<T>(body: string): T[] {
  const out: T[] = [];
  for (const line of body.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // malformed line — drop it and keep going
    }
  }
  return out;
}

async function fetchPartition<T>(prefix: string, key: string): Promise<T[]> {
  try {
    const res = await fetch(`${RAW_BASE}/${prefix}/${key}.jsonl`, {
      next: { revalidate: FETCH_REVALIDATE_SECONDS },
    });
    if (!res.ok) return [];
    return parseJsonl<T>(await res.text());
  } catch {
    return [];
  }
}

export interface IndexedTransferQuery {
  /** Address to match on `from` or `to` (either lowercase or checksum; we normalize). */
  address: string;
  /** How many day-partitions to probe. Defaults to 30. */
  days?: number;
  /** Max rows to return (newest first). Applied after filtering. */
  limit?: number;
}

export interface IndexedTransferResult {
  rows: IndexedTransferRow[];
  cursor: IndexedCursor;
}

/**
 * Loads transfers touching `address` from the indexer. Returns null
 * when the data branch is unavailable so callers can fall back to
 * RPC.
 *
 * We filter client-side after fetching partitions because the current
 * on-disk layout is day-sharded, not address-sharded. For the sizes
 * we're dealing with (a few thousand rows per day, one network,
 * bounded by `days`), this is fine; if the explorer grows to serve
 * an address that dwarfs the rest of the chain, we'll add an
 * address-sharded write path in the indexer.
 */
export async function fetchIndexedAddressTransfers(
  q: IndexedTransferQuery,
): Promise<IndexedTransferResult | null> {
  const cursor = await fetchIndexedCursor();
  if (!cursor) return null;

  const needle = q.address.toLowerCase();
  const keys = recentPartitionKeys(new Date(), q.days ?? DEFAULT_LOOKBACK_DAYS);
  const shards = await Promise.all(
    keys.map((k) => fetchPartition<IndexedTransferRow>('transfers', k)),
  );

  const rows: IndexedTransferRow[] = [];
  for (const shard of shards) {
    for (const r of shard) {
      if (r.from === needle || r.to === needle) rows.push(r);
    }
  }
  rows.sort((a, b) => {
    if (a.block !== b.block) return b.block - a.block;
    return b.logIndex - a.logIndex;
  });
  return {
    rows: q.limit ? rows.slice(0, q.limit) : rows,
    cursor,
  };
}

/**
 * Loads sync events for a given pool address from the indexer. Same
 * availability semantics as `fetchIndexedAddressTransfers`.
 */
export async function fetchIndexedPairSyncs(
  pair: string,
  days: number = DEFAULT_LOOKBACK_DAYS,
): Promise<{ rows: IndexedSyncRow[]; cursor: IndexedCursor } | null> {
  const cursor = await fetchIndexedCursor();
  if (!cursor) return null;

  const needle = pair.toLowerCase();
  const keys = recentPartitionKeys(new Date(), days);
  const shards = await Promise.all(
    keys.map((k) => fetchPartition<IndexedSyncRow>('syncs', k)),
  );

  const rows: IndexedSyncRow[] = [];
  for (const shard of shards) {
    for (const r of shard) {
      if (r.pair === needle) rows.push(r);
    }
  }
  rows.sort((a, b) => {
    if (a.block !== b.block) return a.block - b.block;
    return a.logIndex - b.logIndex;
  });
  return { rows, cursor };
}
