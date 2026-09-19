import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { Redis } from 'ioredis';

const LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

type Bucket = {
  count: number;
  resetAt: number;
};

interface BucketStore {
  /** Increment the bucket for `key` and return its post-increment state. */
  hit(key: string, windowMs: number): Promise<Bucket>;
}

const memoryBuckets = new Map<string, Bucket>();

function memoryStore(): BucketStore {
  return {
    async hit(key, windowMs) {
      const t = now();
      const existing = memoryBuckets.get(key);
      const bucket = existing && existing.resetAt > t ? existing : { count: 0, resetAt: t + windowMs };
      bucket.count += 1;
      memoryBuckets.set(key, bucket);
      return bucket;
    },
  };
}

function redisStore(url: string): BucketStore {
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  client.on('error', () => {
    /* surfaced via command failures; fallback handled in consume */
  });
  const memory = memoryStore();
  return {
    async hit(key, windowMs) {
      try {
        const [[, count], [, pttl]] = (await client
          .multi()
          .incr(key)
          .pttl(key)
          .exec()) as [[null, number], [null, number]];
        let ttl = pttl;
        if (ttl < 0) {
          await client.pexpire(key, windowMs);
          ttl = windowMs;
        }
        return { count, resetAt: now() + ttl };
      } catch {
        return memory.hit(key, windowMs);
      }
    },
  };
}

let cachedStore: BucketStore | null = null;
function store(): BucketStore {
  if (cachedStore) return cachedStore;
  const url = process.env.REDIS_URL;
  cachedStore = url ? redisStore(url) : memoryStore();
  return cachedStore;
}

function now(): number {
  return Date.now();
}

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = req.headers.get('x-real-ip')?.trim();
  const vercelIp = req.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || realIp || vercelIp || 'unknown';
}

function rateLimitHeaders(bucket: Bucket, limit: number): HeadersInit {
  const remaining = Math.max(0, limit - bucket.count);
  const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000));

  return {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.ceil(bucket.resetAt / 1000)),
    'retry-after': String(resetSeconds),
  };
}

export interface RateLimitOptions {
  /** Separate bucket namespace (default: shared Labs query bucket). */
  scope?: string;
  limit?: number;
  windowMs?: number;
}

export async function consumeLabsRateLimit(
  req: NextRequest,
  opts: RateLimitOptions = {},
): Promise<
  | { ok: true; headers: HeadersInit }
  | { ok: false; status: number; body: { error: string; retryAfterSeconds: number }; headers: HeadersInit }
> {
  const limit = opts.limit ?? LIMIT;
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const ip = getClientIp(req);
  const key = `labs:ratelimit:${opts.scope ?? 'query'}:${hashIp(ip)}`;

  const bucket = await store().hit(key, windowMs);

  if (bucket.count > limit) {
    const headers = rateLimitHeaders(bucket, limit);
    return {
      ok: false,
      status: 429,
      body: {
        error: 'Labs query limit reached. Try again after the hourly reset.',
        retryAfterSeconds: Number(headers['retry-after' as keyof HeadersInit] ?? 3600),
      },
      headers,
    };
  }

  return { ok: true, headers: rateLimitHeaders(bucket, limit) };
}
