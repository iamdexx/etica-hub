/**
 * Labs Autopilot job queue.
 *
 * The website pushes user-submitted research goals into Redis; a GitHub
 * Actions worker pops them on a cadence, runs the Nvidia Nemotron plan ->
 * ESMFold -> Nemotron analyse loop, and writes results back to the same Redis. The
 * public `/labs/feed` page reads from here too.
 *
 * Backends supported, in priority order:
 *   1. Upstash REST (`LABS_KV_REST_API_URL` + `LABS_KV_REST_API_TOKEN`)
 *   2. Generic TCP Redis (`REDIS_URL`, e.g. Upstash TCP or Redis Cloud)
 *   3. In-memory map (local dev / unit tests / preview without secrets)
 *
 * We deliberately reuse the same env vars the buybot already uses (PR #98)
 * so deploying autopilot doesn't require provisioning new credentials. The
 * REDIS_URL constant is exported separately for visibility.
 */

import { Redis } from 'ioredis';

import type { LabsJob, LabsJobStatus, LabsJobEvent, LabsFeedEntry } from './job';

const PENDING_KEY = 'labs:queue:pending';
const FEED_KEY = 'labs:feed';
const JOB_PREFIX = 'labs:job:';
const RECENT_FEED_CAP = 50;
const JOB_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface LabsQueue {
  /** Push a new job onto the pending queue + register it in the feed index. */
  enqueue(job: LabsJob): Promise<void>;
  /** Pop the oldest pending job ID (worker side). FIFO. */
  popPending(): Promise<string | null>;
  /** Load a job by ID. */
  get(id: string): Promise<LabsJob | null>;
  /** Replace a job in storage (used on every status/event transition). */
  put(job: LabsJob): Promise<void>;
  /** Return the most recent feed entries, newest first. */
  recent(limit?: number): Promise<LabsFeedEntry[]>;
  /** Snapshot count of pending jobs (best-effort). */
  pendingCount(): Promise<number>;
}

function jobKey(id: string): string {
  return `${JOB_PREFIX}${id}`;
}

function safeParse(raw: string | null): LabsJob | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LabsJob;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function feedEntryFromJob(job: LabsJob): LabsFeedEntry {
  return {
    id: job.id,
    prompt: job.prompt,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    iterations: job.iterations,
    goalId: job.goalId,
    moderation: job.moderation,
  };
}

/** Upstash REST adapter using only `fetch`. */
export function restLabsQueue(url: string, token: string): LabsQueue {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`labs-queue ${path}: ${res.status}`);
    return res.json();
  }

  /** Send a Redis command using the request body (array format) to avoid
   *  URL-length limits for large values like serialized job payloads. */
  async function bodyCmd(args: string[]): Promise<unknown> {
    const res = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`labs-queue bodyCmd [${args[0]}]: ${res.status}`);
    return res.json();
  }

  return {
    async enqueue(job) {
      const key = jobKey(job.id);
      await bodyCmd(['SET', key, JSON.stringify(job), 'EX', String(JOB_TTL_SECONDS)]);
      await call(`/lpush/${encodeURIComponent(PENDING_KEY)}/${encodeURIComponent(job.id)}`, {
        method: 'POST',
      });
      await call(
        `/zadd/${encodeURIComponent(FEED_KEY)}/${job.createdAt}/${encodeURIComponent(job.id)}`,
        { method: 'POST' },
      );
    },
    async popPending() {
      const json = (await call(`/rpop/${encodeURIComponent(PENDING_KEY)}`, {
        method: 'POST',
      })) as { result?: string | null };
      return json.result ?? null;
    },
    async get(id) {
      const json = (await call(`/get/${encodeURIComponent(jobKey(id))}`)) as {
        result?: string | null;
      };
      return safeParse(json.result ?? null);
    },
    async put(job) {
      const key = jobKey(job.id);
      await bodyCmd(['SET', key, JSON.stringify(job), 'EX', String(JOB_TTL_SECONDS)]);
      await call(
        `/zadd/${encodeURIComponent(FEED_KEY)}/${job.updatedAt}/${encodeURIComponent(job.id)}`,
        { method: 'POST' },
      );
    },
    async recent(limit = RECENT_FEED_CAP) {
      const max = Math.max(1, Math.min(RECENT_FEED_CAP, limit));
      // ZREVRANGE returns newest first.
      const json = (await call(
        `/zrevrange/${encodeURIComponent(FEED_KEY)}/0/${max - 1}`,
      )) as { result?: string[] };
      const ids = Array.isArray(json.result) ? json.result : [];
      if (!ids.length) return [];
      const entries: LabsFeedEntry[] = [];
      for (const id of ids) {
        const job = await this.get(id);
        if (job) entries.push(feedEntryFromJob(job));
      }
      return entries;
    },
    async pendingCount() {
      const json = (await call(`/llen/${encodeURIComponent(PENDING_KEY)}`)) as {
        result?: number;
      };
      return typeof json.result === 'number' ? json.result : 0;
    },
  };
}

const tcpClients = new Map<string, Redis>();

/** ioredis-backed adapter for `redis://` / `rediss://`. */
export function tcpLabsQueue(url: string): LabsQueue {
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
    async enqueue(job) {
      const key = jobKey(job.id);
      await conn.set(key, JSON.stringify(job), 'EX', JOB_TTL_SECONDS);
      await conn.lpush(PENDING_KEY, job.id);
      await conn.zadd(FEED_KEY, job.createdAt, job.id);
    },
    async popPending() {
      const v = await conn.rpop(PENDING_KEY);
      return v ?? null;
    },
    async get(id) {
      const v = await conn.get(jobKey(id));
      return safeParse(v);
    },
    async put(job) {
      const key = jobKey(job.id);
      await conn.set(key, JSON.stringify(job), 'EX', JOB_TTL_SECONDS);
      await conn.zadd(FEED_KEY, job.updatedAt, job.id);
    },
    async recent(limit = RECENT_FEED_CAP) {
      const max = Math.max(1, Math.min(RECENT_FEED_CAP, limit));
      const ids = await conn.zrevrange(FEED_KEY, 0, max - 1);
      if (!ids.length) return [];
      const entries: LabsFeedEntry[] = [];
      for (const id of ids) {
        const v = await conn.get(jobKey(id));
        const job = safeParse(v);
        if (job) entries.push(feedEntryFromJob(job));
      }
      return entries;
    },
    async pendingCount() {
      return await conn.llen(PENDING_KEY);
    },
  };
}

/** In-memory queue used for local dev + missing-credential fallback. */
export function memoryLabsQueue(): LabsQueue {
  const jobs = new Map<string, LabsJob>();
  const pending: string[] = [];
  return {
    async enqueue(job) {
      jobs.set(job.id, job);
      pending.unshift(job.id);
    },
    async popPending() {
      return pending.pop() ?? null;
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async put(job) {
      jobs.set(job.id, job);
    },
    async recent(limit = RECENT_FEED_CAP) {
      const max = Math.max(1, Math.min(RECENT_FEED_CAP, limit));
      return Array.from(jobs.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max)
        .map(feedEntryFromJob);
    },
    async pendingCount() {
      return pending.length;
    },
  };
}

let cached: LabsQueue | null = null;

/**
 * Resolve the queue once per process. We don't memoise the credential
 * lookup itself so tests can override env between calls by clearing the
 * cache via {@link _resetLabsQueueForTests}.
 */
export function labsQueue(): LabsQueue {
  if (cached) return cached;
  const restUrl = process.env.LABS_KV_REST_API_URL ?? process.env.KV_REST_API_URL ?? null;
  const restToken = process.env.LABS_KV_REST_API_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;
  const redisUrl = process.env.REDIS_URL ?? null;
  if (restUrl && restToken) {
    cached = restLabsQueue(restUrl, restToken);
  } else if (redisUrl) {
    cached = tcpLabsQueue(redisUrl);
  } else {
    cached = memoryLabsQueue();
  }
  return cached;
}

export function _resetLabsQueueForTests(): void {
  cached = null;
}

export const LABS_QUEUE_PENDING_KEY = PENDING_KEY;
export const LABS_QUEUE_FEED_KEY = FEED_KEY;
export const LABS_JOB_KEY_PREFIX = JOB_PREFIX;

export function appendJobEvent(job: LabsJob, event: Omit<LabsJobEvent, 'at'>): LabsJob {
  const now = Date.now();
  const next: LabsJob = {
    ...job,
    updatedAt: now,
    events: [...job.events, { ...event, at: now }].slice(-200),
  };
  return next;
}

export function withStatus(job: LabsJob, status: LabsJobStatus): LabsJob {
  return { ...job, status, updatedAt: Date.now() };
}
