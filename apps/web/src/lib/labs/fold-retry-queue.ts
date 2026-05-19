/**
 * Fold retry queue.
 *
 * When `foldWithCascade` exhausts every configured engine, we DO NOT
 * drop the candidate on the floor — we push it into a Redis sorted set
 * scored by `nextRetryAt` (ms epoch) so a Vercel cron can drain it
 * later. The cron runs every 5 minutes; combined with a 24h retry
 * budget that's 288 chances per candidate to recover before we hand
 * it off to the sequence-only score path (`structurePending: true`).
 *
 * The queue is intentionally minimal — one ZSET keyed by the worker
 * job id + candidate index. Each entry stores everything the cron
 * needs to re-run the fold cascade and patch the original job's
 * result back in place:
 *
 *   {
 *     id: "<jobId>:<index>",
 *     jobId: "<jobId>",
 *     candidateIndex: 3,
 *     sequence: "MK…",
 *     firstQueuedAt: 1734000000000,
 *     nextRetryAt:  1734000300000,
 *     attempts: 1,
 *     lastError: "…",
 *   }
 *
 * Backends mirror {@link labsQueue}: Upstash REST, generic TCP Redis,
 * or an in-memory fallback for local dev.
 */

import { Redis } from 'ioredis';

const QUEUE_KEY = 'labs:fold-retry-queue';
const ENTRY_PREFIX = 'labs:fold-retry:';
const ENTRY_TTL_SECONDS = 60 * 60 * 48; // 48h — retries cap at 24h, this is a comfortable buffer

/** A pending fold retry. `id` doubles as the ZSET member and Redis hash key. */
export interface FoldRetryEntry {
  id: string;
  jobId: string;
  candidateIndex: number;
  sequence: string;
  firstQueuedAt: number;
  nextRetryAt: number;
  attempts: number;
  lastError?: string;
}

export interface FoldRetryQueue {
  /** Push or update an entry. Idempotent on `id`. */
  schedule(entry: FoldRetryEntry): Promise<void>;
  /** Pop up to `limit` entries whose `nextRetryAt` <= now (sorted oldest first). */
  popReady(now: number, limit: number): Promise<FoldRetryEntry[]>;
  /** Remove an entry (used after a successful retry). */
  remove(id: string): Promise<void>;
  /** Inspect an entry without removing it. */
  get(id: string): Promise<FoldRetryEntry | null>;
  /** Total queued entries (best effort). */
  size(): Promise<number>;
}

function entryKey(id: string): string {
  return `${ENTRY_PREFIX}${id}`;
}

function safeParse(raw: string | null): FoldRetryEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FoldRetryEntry;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.jobId !== 'string') return null;
    if (typeof parsed.candidateIndex !== 'number') return null;
    if (typeof parsed.sequence !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Upstash REST adapter (mirrors restLabsQueue). */
export function restFoldRetryQueue(url: string, token: string): FoldRetryQueue {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`fold-retry ${path}: ${res.status}`);
    return res.json();
  }

  return {
    async schedule(entry) {
      await call(
        `/set/${encodeURIComponent(entryKey(entry.id))}/${encodeURIComponent(JSON.stringify(entry))}/EX/${ENTRY_TTL_SECONDS}`,
        { method: 'POST' },
      );
      await call(
        `/zadd/${encodeURIComponent(QUEUE_KEY)}/${entry.nextRetryAt}/${encodeURIComponent(entry.id)}`,
        { method: 'POST' },
      );
    },
    async popReady(now, limit) {
      const max = Math.max(1, Math.min(50, limit));
      // zrangebyscore -inf <= score <= now, limit 0 max
      const json = (await call(
        `/zrangebyscore/${encodeURIComponent(QUEUE_KEY)}/-inf/${now}/LIMIT/0/${max}`,
      )) as { result?: string[] };
      const ids = Array.isArray(json.result) ? json.result : [];
      const entries: FoldRetryEntry[] = [];
      for (const id of ids) {
        const got = (await call(`/get/${encodeURIComponent(entryKey(id))}`)) as {
          result?: string | null;
        };
        const parsed = safeParse(got.result ?? null);
        if (parsed) entries.push(parsed);
      }
      return entries;
    },
    async remove(id) {
      await call(`/zrem/${encodeURIComponent(QUEUE_KEY)}/${encodeURIComponent(id)}`, {
        method: 'POST',
      });
      await call(`/del/${encodeURIComponent(entryKey(id))}`, { method: 'POST' });
    },
    async get(id) {
      const got = (await call(`/get/${encodeURIComponent(entryKey(id))}`)) as {
        result?: string | null;
      };
      return safeParse(got.result ?? null);
    },
    async size() {
      const got = (await call(`/zcard/${encodeURIComponent(QUEUE_KEY)}`)) as {
        result?: number;
      };
      return typeof got.result === 'number' ? got.result : 0;
    },
  };
}

const tcpClients = new Map<string, Redis>();

/** ioredis adapter. */
export function tcpFoldRetryQueue(url: string): FoldRetryQueue {
  let client = tcpClients.get(url);
  if (!client) {
    client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    tcpClients.set(url, client);
  }
  const conn = client;
  return {
    async schedule(entry) {
      await conn.set(entryKey(entry.id), JSON.stringify(entry), 'EX', ENTRY_TTL_SECONDS);
      await conn.zadd(QUEUE_KEY, entry.nextRetryAt, entry.id);
    },
    async popReady(now, limit) {
      const max = Math.max(1, Math.min(50, limit));
      const ids = await conn.zrangebyscore(QUEUE_KEY, '-inf', now, 'LIMIT', 0, max);
      if (!ids.length) return [];
      const entries: FoldRetryEntry[] = [];
      for (const id of ids) {
        const v = await conn.get(entryKey(id));
        const parsed = safeParse(v);
        if (parsed) entries.push(parsed);
      }
      return entries;
    },
    async remove(id) {
      await conn.zrem(QUEUE_KEY, id);
      await conn.del(entryKey(id));
    },
    async get(id) {
      const v = await conn.get(entryKey(id));
      return safeParse(v);
    },
    async size() {
      return await conn.zcard(QUEUE_KEY);
    },
  };
}

/** In-memory adapter for local dev. */
export function memoryFoldRetryQueue(): FoldRetryQueue {
  const entries = new Map<string, FoldRetryEntry>();
  return {
    async schedule(entry) {
      entries.set(entry.id, entry);
    },
    async popReady(now, limit) {
      const ready = Array.from(entries.values())
        .filter((e) => e.nextRetryAt <= now)
        .sort((a, b) => a.nextRetryAt - b.nextRetryAt)
        .slice(0, limit);
      return ready;
    },
    async remove(id) {
      entries.delete(id);
    },
    async get(id) {
      return entries.get(id) ?? null;
    },
    async size() {
      return entries.size;
    },
  };
}

let cached: FoldRetryQueue | null = null;

export function foldRetryQueue(): FoldRetryQueue {
  if (cached) return cached;
  const restUrl = process.env.LABS_KV_REST_API_URL ?? process.env.KV_REST_API_URL ?? null;
  const restToken = process.env.LABS_KV_REST_API_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;
  const redisUrl = process.env.REDIS_URL ?? null;
  if (restUrl && restToken) {
    cached = restFoldRetryQueue(restUrl, restToken);
  } else if (redisUrl) {
    cached = tcpFoldRetryQueue(redisUrl);
  } else {
    cached = memoryFoldRetryQueue();
  }
  return cached;
}

export function _resetFoldRetryQueueForTests(): void {
  cached = null;
}

/**
 * Retry schedule. Index = `attempts` count *after* the failure that
 * scheduled the retry (1 = first retry). The schedule fans the 24h
 * budget across 12 attempts with widening gaps:
 *
 *   1st retry  → 5 min later
 *   2nd retry  → 15 min later
 *   3rd retry  → 30 min later
 *   4th retry  → 60 min later
 *   5th-12th   → 2h apart
 *   13th+      → null (caller should publish with structurePending)
 *
 * Total budget = 5 + 15 + 30 + 60 + 8 * 120 = 1070 min ≈ 17.8h, well
 * inside the 24h ceiling. We deliberately stop before 24h so we leave
 * room for clock skew between the cron and the upstream provider's
 * recovery window.
 */
const RETRY_SCHEDULE_MINUTES: readonly number[] = [5, 15, 30, 60, 120, 120, 120, 120, 120, 120, 120, 120];

export const FOLD_RETRY_MAX_ATTEMPTS = RETRY_SCHEDULE_MINUTES.length;

export function nextRetryDelayMs(attempts: number): number | null {
  if (attempts < 1 || attempts > RETRY_SCHEDULE_MINUTES.length) return null;
  return RETRY_SCHEDULE_MINUTES[attempts - 1]! * 60 * 1000;
}

export function makeFoldRetryEntryId(jobId: string, candidateIndex: number): string {
  return `${jobId}:${candidateIndex}`;
}

export const LABS_FOLD_RETRY_QUEUE_KEY = QUEUE_KEY;
