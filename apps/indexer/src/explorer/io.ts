/**
 * Filesystem IO for the explorer indexer. Exported as pure helpers so
 * tests can use tmp dirs without spinning up the whole indexer.
 *
 * On-disk layout (all paths relative to `INDEX_DATA_DIR`):
 *
 *   ./cursor.json
 *   ./transfers/YYYY/MM/DD.jsonl   (append-only, one row per line)
 *   ./syncs/YYYY/MM/DD.jsonl
 *
 * The per-day partitioning means that even though the data branch is
 * append-only, a consumer can scan only the days they care about
 * instead of streaming the full history.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IndexCursor, SyncRow, TransferRow } from './types.js';

export const DEFAULT_DATA_DIR = './data';

/** Converts a unix-seconds timestamp to `YYYY/MM/DD.jsonl`. */
export function partitionPath(prefix: string, ts: number): string {
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear().toString();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return join(prefix, yyyy, mm, `${dd}.jsonl`);
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
 * Appends a batch of rows to their day-partitioned JSONL file, one line
 * per row. Rows that span multiple days get written to the right files;
 * callers don't need to pre-group.
 */
export function appendRows<T extends { ts: number }>(
  dataDir: string,
  prefix: string,
  rows: readonly T[],
): void {
  if (rows.length === 0) return;
  const buckets = new Map<string, string[]>();
  for (const row of rows) {
    const path = join(dataDir, partitionPath(prefix, row.ts));
    const bucket = buckets.get(path) ?? [];
    bucket.push(JSON.stringify(row));
    buckets.set(path, bucket);
  }
  for (const [path, lines] of buckets) {
    ensureDir(path);
    appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  }
}

export function appendTransfers(dataDir: string, rows: readonly TransferRow[]): void {
  appendRows(dataDir, 'transfers', rows);
}

export function appendSyncs(dataDir: string, rows: readonly SyncRow[]): void {
  appendRows(dataDir, 'syncs', rows);
}
