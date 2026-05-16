import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

const LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;

type Bucket = {
  count: number;
  resetAt: number;
};

const memoryBuckets = new Map<string, Bucket>();

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

function rateLimitHeaders(bucket: Bucket): HeadersInit {
  const remaining = Math.max(0, LIMIT - bucket.count);
  const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000));

  return {
    'x-ratelimit-limit': String(LIMIT),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.ceil(bucket.resetAt / 1000)),
    'retry-after': String(resetSeconds),
  };
}

export async function consumeLabsRateLimit(req: NextRequest): Promise<
  | { ok: true; headers: HeadersInit }
  | { ok: false; status: number; body: { error: string; retryAfterSeconds: number }; headers: HeadersInit }
> {
  const ip = getClientIp(req);
  const key = `labs:${hashIp(ip)}`;
  const t = now();

  const existing = memoryBuckets.get(key);
  const bucket = existing && existing.resetAt > t ? existing : { count: 0, resetAt: t + WINDOW_MS };

  if (bucket.count >= LIMIT) {
    const headers = rateLimitHeaders(bucket);
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

  bucket.count += 1;
  memoryBuckets.set(key, bucket);

  return { ok: true, headers: rateLimitHeaders(bucket) };
}
