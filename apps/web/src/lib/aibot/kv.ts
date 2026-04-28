/**
 * Tiny KV adapter for the AI bot's daily-quota counters.
 *
 * The buybot KV (`@/lib/buybot/state`) only exposes `get`, `set`, and
 * `setIfAbsent` — none of which give us atomic increment-with-TTL, which
 * is what we want for the per-chat reply counter and the global USD
 * spend counter. Rather than complicate the shared interface, we ship a
 * second, single-purpose adapter here that uses INCR / INCRBYFLOAT +
 * EXPIRE on whichever backend is configured (Upstash REST or ioredis
 * TCP), or falls back to an in-memory map for local dev / tests.
 *
 * The contract is intentionally narrow:
 *
 *   - `incrCounter(key, ttlSeconds)` adds 1 to the integer at `key`
 *     (creating it at 1 if missing), sets a TTL of `ttlSeconds` on
 *     first write, and returns the new value.
 *   - `incrFloat(key, delta, ttlSeconds)` does the same for a float
 *     delta (used for USD spend tracking).
 *   - `getNumber(key)` returns the current numeric value or 0.
 */

import { Redis } from 'ioredis';

export interface AiBotKv {
  /** Read a numeric value at `key`. Returns 0 when missing or malformed. */
  getNumber(key: string): Promise<number>;
  /** Atomic INCR by 1; sets TTL on first write. Returns the new value. */
  incrCounter(key: string, ttlSeconds: number): Promise<number>;
  /** Atomic INCRBYFLOAT by `delta`; sets TTL on first write. */
  incrFloat(key: string, delta: number, ttlSeconds: number): Promise<number>;
}

interface AiBotKvSource {
  kvRestUrl: string | null;
  kvRestToken: string | null;
  redisUrl: string | null;
}

/** Upstash REST adapter using only `fetch`. */
export function restAiBotKv(url: string, token: string): AiBotKv {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };

  async function rawNumber(key: string): Promise<number> {
    const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
      headers,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`aibot-kv get ${key}: ${res.status}`);
    const json = (await res.json()) as { result?: string | null };
    if (!json.result) return 0;
    const n = Number(json.result);
    return Number.isFinite(n) ? n : 0;
  }

  async function expire(key: string, ttlSeconds: number): Promise<void> {
    const path = `${base}/expire/${encodeURIComponent(key)}/${ttlSeconds}`;
    const res = await fetch(path, { method: 'POST', headers });
    if (!res.ok) throw new Error(`aibot-kv expire ${key}: ${res.status}`);
  }

  return {
    getNumber: rawNumber,
    async incrCounter(key, ttlSeconds) {
      const path = `${base}/incr/${encodeURIComponent(key)}`;
      const res = await fetch(path, { method: 'POST', headers });
      if (!res.ok) throw new Error(`aibot-kv incr ${key}: ${res.status}`);
      const json = (await res.json()) as { result?: number };
      const next = typeof json.result === 'number' ? json.result : 0;
      // Re-anchor TTL on every write. Upstash's INCR doesn't reset TTL
      // on its own, and we want the counter to expire ~30h after the
      // last activity rather than 30h after the first one (saves a
      // round trip when nothing changes overnight).
      await expire(key, ttlSeconds);
      return next;
    },
    async incrFloat(key, delta, ttlSeconds) {
      const path = `${base}/incrbyfloat/${encodeURIComponent(key)}/${delta}`;
      const res = await fetch(path, { method: 'POST', headers });
      if (!res.ok) throw new Error(`aibot-kv incrbyfloat ${key}: ${res.status}`);
      const json = (await res.json()) as { result?: number | string };
      const raw = typeof json.result === 'string' ? Number(json.result) : json.result;
      await expire(key, ttlSeconds);
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    },
  };
}

/** ioredis-backed adapter for `redis://` / `rediss://`. */
const tcpClients = new Map<string, Redis>();
export function tcpAiBotKv(url: string): AiBotKv {
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
    async getNumber(key) {
      const v = await conn.get(key);
      if (!v) return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    },
    async incrCounter(key, ttlSeconds) {
      const next = await conn.incr(key);
      await conn.expire(key, ttlSeconds);
      return next;
    },
    async incrFloat(key, delta, ttlSeconds) {
      const next = await conn.incrbyfloat(key, delta);
      await conn.expire(key, ttlSeconds);
      const n = Number(next);
      return Number.isFinite(n) ? n : 0;
    },
  };
}

/** In-memory adapter for unit tests + missing-credential fallback. */
export function memoryAiBotKv(): AiBotKv {
  const m = new Map<string, number>();
  return {
    async getNumber(key) {
      return m.get(key) ?? 0;
    },
    async incrCounter(key) {
      const next = (m.get(key) ?? 0) + 1;
      m.set(key, next);
      return next;
    },
    async incrFloat(key, delta) {
      const next = (m.get(key) ?? 0) + delta;
      m.set(key, next);
      return next;
    },
  };
}

/** Pick the right backend based on config; null when none is configured. */
export function aiBotKvFor(source: AiBotKvSource): AiBotKv | null {
  if (source.kvRestUrl && source.kvRestToken) {
    return restAiBotKv(source.kvRestUrl, source.kvRestToken);
  }
  if (source.redisUrl) {
    return tcpAiBotKv(source.redisUrl);
  }
  return null;
}
