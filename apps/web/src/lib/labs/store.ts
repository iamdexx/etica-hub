/**
 * Thin Redis-primitive adapter shared by the Labs goals + moderation
 * subsystems. Reuses the same backend resolution as `labsQueue()` so
 * deploying these features needs no new credentials:
 *
 *   1. Upstash REST  (`LABS_KV_REST_API_URL` + `LABS_KV_REST_API_TOKEN`)
 *   2. Generic TCP   (`REDIS_URL`)
 *   3. In-memory     (local dev / preview without secrets)
 *
 * We deliberately ship only the small subset of commands we actually
 * need (GET/SET/DEL/INCR/EXPIRE + ZADD/ZREVRANGE/ZCARD + SADD/SREM/
 * SISMEMBER/SMEMBERS/SCARD). Each backend implements exactly these.
 */

import { Redis } from 'ioredis';

const tcpClients = new Map<string, Redis>();

export interface LabsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;

  zadd(key: string, score: number, member: string): Promise<void>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<void>;
  zcard(key: string): Promise<number>;

  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  sismember(key: string, member: string): Promise<boolean>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
}

/* ------------------------------------------------------------------ */
/*  Upstash REST adapter                                               */
/* ------------------------------------------------------------------ */

function restStore(url: string, token: string): LabsStore {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`labs-store ${path}: ${res.status}`);
    return res.json();
  }

  const enc = encodeURIComponent;

  return {
    async get(key) {
      const j = (await call(`/get/${enc(key)}`)) as { result?: string | null };
      return j.result ?? null;
    },
    async set(key, value, ttlSeconds) {
      const path = ttlSeconds
        ? `/set/${enc(key)}/${enc(value)}/EX/${ttlSeconds}`
        : `/set/${enc(key)}/${enc(value)}`;
      await call(path, { method: 'POST' });
    },
    async del(key) {
      await call(`/del/${enc(key)}`, { method: 'POST' });
    },
    async incr(key) {
      const j = (await call(`/incr/${enc(key)}`, { method: 'POST' })) as { result?: number };
      return typeof j.result === 'number' ? j.result : 0;
    },
    async expire(key, ttl) {
      await call(`/expire/${enc(key)}/${ttl}`, { method: 'POST' });
    },
    async zadd(key, score, member) {
      await call(`/zadd/${enc(key)}/${score}/${enc(member)}`, { method: 'POST' });
    },
    async zrevrange(key, start, stop) {
      const j = (await call(`/zrevrange/${enc(key)}/${start}/${stop}`)) as { result?: string[] };
      return Array.isArray(j.result) ? j.result : [];
    },
    async zrange(key, start, stop) {
      const j = (await call(`/zrange/${enc(key)}/${start}/${stop}`)) as { result?: string[] };
      return Array.isArray(j.result) ? j.result : [];
    },
    async zrem(key, member) {
      await call(`/zrem/${enc(key)}/${enc(member)}`, { method: 'POST' });
    },
    async zcard(key) {
      const j = (await call(`/zcard/${enc(key)}`)) as { result?: number };
      return typeof j.result === 'number' ? j.result : 0;
    },
    async sadd(key, member) {
      const j = (await call(`/sadd/${enc(key)}/${enc(member)}`, { method: 'POST' })) as {
        result?: number;
      };
      return typeof j.result === 'number' ? j.result : 0;
    },
    async srem(key, member) {
      const j = (await call(`/srem/${enc(key)}/${enc(member)}`, { method: 'POST' })) as {
        result?: number;
      };
      return typeof j.result === 'number' ? j.result : 0;
    },
    async sismember(key, member) {
      const j = (await call(`/sismember/${enc(key)}/${enc(member)}`)) as { result?: number };
      return j.result === 1;
    },
    async smembers(key) {
      const j = (await call(`/smembers/${enc(key)}`)) as { result?: string[] };
      return Array.isArray(j.result) ? j.result : [];
    },
    async scard(key) {
      const j = (await call(`/scard/${enc(key)}`)) as { result?: number };
      return typeof j.result === 'number' ? j.result : 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  ioredis adapter                                                    */
/* ------------------------------------------------------------------ */

function tcpStore(url: string): LabsStore {
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
    async get(key) {
      return (await conn.get(key)) ?? null;
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds) await conn.set(key, value, 'EX', ttlSeconds);
      else await conn.set(key, value);
    },
    async del(key) {
      await conn.del(key);
    },
    async incr(key) {
      return await conn.incr(key);
    },
    async expire(key, ttl) {
      await conn.expire(key, ttl);
    },
    async zadd(key, score, member) {
      await conn.zadd(key, score, member);
    },
    async zrevrange(key, start, stop) {
      return await conn.zrevrange(key, start, stop);
    },
    async zrange(key, start, stop) {
      return await conn.zrange(key, start, stop);
    },
    async zrem(key, member) {
      await conn.zrem(key, member);
    },
    async zcard(key) {
      return await conn.zcard(key);
    },
    async sadd(key, member) {
      return await conn.sadd(key, member);
    },
    async srem(key, member) {
      return await conn.srem(key, member);
    },
    async sismember(key, member) {
      return (await conn.sismember(key, member)) === 1;
    },
    async smembers(key) {
      return await conn.smembers(key);
    },
    async scard(key) {
      return await conn.scard(key);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  In-memory fallback                                                 */
/* ------------------------------------------------------------------ */

function memoryStore(): LabsStore {
  const kv = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();

  function getZ(key: string): Map<string, number> {
    let z = zsets.get(key);
    if (!z) {
      z = new Map();
      zsets.set(key, z);
    }
    return z;
  }
  function getS(key: string): Set<string> {
    let s = sets.get(key);
    if (!s) {
      s = new Set();
      sets.set(key, s);
    }
    return s;
  }
  function sortedDesc(key: string): string[] {
    const z = getZ(key);
    return Array.from(z.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([m]) => m);
  }

  return {
    async get(key) {
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      kv.set(key, value);
    },
    async del(key) {
      kv.delete(key);
    },
    async incr(key) {
      const next = (Number(kv.get(key) ?? 0) || 0) + 1;
      kv.set(key, String(next));
      return next;
    },
    async expire() {
      // No-op in memory.
    },
    async zadd(key, score, member) {
      getZ(key).set(member, score);
    },
    async zrevrange(key, start, stop) {
      const all = sortedDesc(key);
      const end = stop < 0 ? all.length + stop + 1 : stop + 1;
      return all.slice(Math.max(0, start), end);
    },
    async zrange(key, start, stop) {
      const all = sortedDesc(key).reverse();
      const end = stop < 0 ? all.length + stop + 1 : stop + 1;
      return all.slice(Math.max(0, start), end);
    },
    async zrem(key, member) {
      getZ(key).delete(member);
    },
    async zcard(key) {
      return getZ(key).size;
    },
    async sadd(key, member) {
      const s = getS(key);
      const had = s.has(member);
      s.add(member);
      return had ? 0 : 1;
    },
    async srem(key, member) {
      const s = getS(key);
      const had = s.has(member);
      s.delete(member);
      return had ? 1 : 0;
    },
    async sismember(key, member) {
      return getS(key).has(member);
    },
    async smembers(key) {
      return Array.from(getS(key));
    },
    async scard(key) {
      return getS(key).size;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Resolver                                                           */
/* ------------------------------------------------------------------ */

let cached: LabsStore | null = null;

export function labsStore(): LabsStore {
  if (cached) return cached;
  const restUrl = process.env.LABS_KV_REST_API_URL ?? process.env.KV_REST_API_URL ?? null;
  const restToken = process.env.LABS_KV_REST_API_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;
  const redisUrl = process.env.REDIS_URL ?? null;
  if (restUrl && restToken) {
    cached = restStore(restUrl, restToken);
  } else if (redisUrl) {
    cached = tcpStore(redisUrl);
  } else {
    cached = memoryStore();
  }
  return cached;
}

export function _resetLabsStoreForTests(): void {
  cached = null;
}
