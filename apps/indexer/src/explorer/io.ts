/**
 * Filesystem IO for the explorer indexer. Exported as pure helpers so
 * tests can use tmp dirs without spinning up the whole indexer.
 *
 * On-disk layout (all paths relative to `INDEX_DATA_DIR`):
 *
 *   ./cursor.json
 *   ./transfers/YYYY/MM/DD.jsonl.gz       (shard 0 — default)
 *   ./transfers/YYYY/MM/DD.1.jsonl.gz     (shard 1 — appears on rollover)
 *   ./transfers/YYYY/MM/DD.2.jsonl.gz     (shard 2 — etc.)
 *   ./syncs/YYYY/MM/DD.jsonl.gz ...
 *
 * Gzip + day-partitioning lets the reader scan only the days it cares
 * about without streaming the full history. Gzip gives roughly 10x
 * shrink on our row shape, buying an extra order of magnitude of
 * chain activity before we'd need any other mitigation.
 *
 * Self-healing rollover: if the active shard for a day ever reaches
 * `ROLLOVER_THRESHOLD_BYTES` (50 MB — half of GitHub's 100 MB per-file
 * hard cap) the writer seamlessly opens the next shard. Readers walk
 * shards in order until they hit a 404. This means the indexer keeps
 * working indefinitely as chain activity grows: a normal day has one
 * shard, a busy day has two, a pathological day has ten. No config,
 * no manual intervention, no assumption about future volume.
 *
 * Append semantics are preserved at the API level: callers still call
 * `appendTransfers`/`appendSyncs` and the rows land in the right shard.
 * Under the hood each write does a read-decompress-append-compress-
 * write cycle on the active shard (gzip isn't natively append-
 * friendly). For our scale (one write every ~10 minutes, individual
 * shards capped at 50 MB) this is cheap.
 *
 * Legacy `.jsonl` files from the pre-gzip indexer are migrated into
 * shard 0 on first write and the plain file is deleted.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { IndexCursor, SyncRow, TransferRow } from './types.js';

export const DEFAULT_DATA_DIR = './data';

/**
 * Rollover threshold for individual shard files. Set to half of
 * GitHub's 100 MB per-file hard cap so even a worst-case single-write
 * batch can't cross the ceiling after rollover. Tunable without a
 * migration — shrinking it makes future shards smaller, growing it
 * lets existing shards grow until they cross the new threshold.
 */
export const ROLLOVER_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Converts a unix-seconds timestamp to a day-base path `YYYY/MM/DD`. */
export function partitionDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear().toString();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/** Path of a specific shard. Shard 0 has no numeric suffix. */
export function shardPath(prefix: string, dayKey: string, shard: number): string {
  const tail = shard === 0 ? `${dayKey}.jsonl.gz` : `${dayKey}.${shard}.jsonl.gz`;
  return join(prefix, tail);
}

/** Legacy un-gzipped shard-0 path; kept so the writer can migrate older files. */
function legacyShardZeroPath(prefix: string, dayKey: string): string {
  return join(prefix, `${dayKey}.jsonl`);
}

/**
 * Back-compat: older callers / tests may expect a single path per
 * timestamp. Always returns the shard-0 path.
 */
export function partitionPath(prefix: string, ts: number): string {
  return shardPath(prefix, partitionDayKey(ts), 0);
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Loads the cursor file. Returns `null` if the file doesn't exist yet —
 * the caller is responsible for deciding where to start from.
 */
export function loadCursor(dataDir: string): IndexCursor | null {
  const path = join(dataDir, 'cursor.json');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as IndexCursor;
}

export function saveCursor(dataDir: string, cursor: IndexCursor): void {
  const path = join(dataDir, 'cursor.json');
  ensureDir(path);
  writeFileSync(path, `${JSON.stringify(cursor, null, 2)}\n`, 'utf8');
}

/**
 * Returns the path of the shard that a new write should land in, plus
 * any existing body the writer should absorb before appending.
 *
 * Decision tree:
 *   - No shards exist yet: write to shard 0.
 *     - If a legacy un-gzipped `.jsonl` file exists for this day, its
 *       rows are absorbed into shard 0 and the plain file is removed.
 *   - Active (highest-numbered) shard is below the rollover threshold:
 *     append to it.
 *   - Active shard is at or above the threshold: start a new empty
 *     shard. Existing shards are left untouched.
 */
function pickActiveShard(
  dataDir: string,
  prefix: string,
  dayKey: string,
): { path: string; existing: string } {
  // Walk existing shards in order. Highest N present is the active one.
  let highest = -1;
  for (let n = 0; n < 10_000; n++) {
    const p = join(dataDir, shardPath(prefix, dayKey, n));
    if (!existsSync(p)) break;
    highest = n;
  }

  if (highest === -1) {
    // No shards yet. Check for a legacy plain .jsonl to migrate.
    const shard0 = join(dataDir, shardPath(prefix, dayKey, 0));
    const legacy = join(dataDir, legacyShardZeroPath(prefix, dayKey));
    if (existsSync(legacy)) {
      const existing = readFileSync(legacy, 'utf8');
      rmSync(legacy);
      return { path: shard0, existing };
    }
    return { path: shard0, existing: '' };
  }

  const activePath = join(dataDir, shardPath(prefix, dayKey, highest));
  const activeSize = statSync(activePath).size;
  if (activeSize < ROLLOVER_THRESHOLD_BYTES) {
    const existing = gunzipSync(readFileSync(activePath)).toString('utf8');
    return { path: activePath, existing };
  }
  // Active shard is at threshold — roll to the next empty shard.
  const nextPath = join(dataDir, shardPath(prefix, dayKey, highest + 1));
  return { path: nextPath, existing: '' };
}

/**
 * Appends a batch of rows to their day-partitioned gzip shards, one
 * line per row. Rows that span multiple days get written to the right
 * shards; callers don't need to pre-group.
 */
export function appendRows<T extends { ts: number }>(
  dataDir: string,
  prefix: string,
  rows: readonly T[],
): void {
  if (rows.length === 0) return;
  const buckets = new Map<string, string[]>();
  for (const row of rows) {
    const dayKey = partitionDayKey(row.ts);
    const bucket = buckets.get(dayKey) ?? [];
    bucket.push(JSON.stringify(row));
    buckets.set(dayKey, bucket);
  }
  for (const [dayKey, lines] of buckets) {
    const { path, existing } = pickActiveShard(dataDir, prefix, dayKey);
    ensureDir(path);
    const combined = `${existing}${lines.join('\n')}\n`;
    writeFileSync(path, gzipSync(combined));
  }
}

export function appendTransfers(dataDir: string, rows: readonly TransferRow[]): void {
  appendRows(dataDir, 'transfers', rows);
}

export function appendSyncs(dataDir: string, rows: readonly SyncRow[]): void {
  appendRows(dataDir, 'syncs', rows);
}
