/**
 * Uptime history for `/status`.
 *
 * The Vercel telemetry cron (every 15 min) records one health sample per
 * run into the shared Labs KV store (sorted set keyed by timestamp). The
 * status page reads the last 7 days back and renders an availability strip.
 * Storage footprint is bounded to `MAX_SAMPLES` members.
 */

import { labsStore } from '@/lib/labs/store';

export const UPTIME_KEY = 'ops:uptime:samples';
export const UPTIME_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 800;

export interface UptimeSample {
  /** Unix ms. */
  at: number;
  ok: boolean;
  /** Head block age in seconds at sample time; null when RPC failed. */
  headAgeSeconds: number | null;
  responseTimeMs: number | null;
}

export function encodeSample(s: UptimeSample): string {
  return [s.at, s.ok ? 1 : 0, s.headAgeSeconds ?? '', s.responseTimeMs ?? ''].join(':');
}

export function decodeSample(member: string): UptimeSample | null {
  const [at, ok, age, rt] = member.split(':');
  const ts = Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return {
    at: ts,
    ok: ok === '1',
    headAgeSeconds: age === '' || age === undefined ? null : Number(age),
    responseTimeMs: rt === '' || rt === undefined ? null : Number(rt),
  };
}

export async function recordUptimeSample(sample: UptimeSample): Promise<void> {
  const kv = labsStore();
  await kv.zadd(UPTIME_KEY, sample.at, encodeSample(sample));
  const total = await kv.zcard(UPTIME_KEY);
  if (total > MAX_SAMPLES) {
    const stale = await kv.zrange(UPTIME_KEY, 0, total - MAX_SAMPLES - 1);
    await Promise.all(stale.map((m) => kv.zrem(UPTIME_KEY, m)));
  }
}

export async function loadUptimeSamples(sinceMs = Date.now() - UPTIME_RETENTION_MS): Promise<UptimeSample[]> {
  const members = await labsStore().zrange(UPTIME_KEY, 0, -1);
  return members
    .map(decodeSample)
    .filter((s): s is UptimeSample => s !== null && s.at >= sinceMs)
    .sort((a, b) => a.at - b.at);
}

export interface UptimeBucket {
  start: number;
  end: number;
  total: number;
  ok: number;
}

export function bucketize(samples: UptimeSample[], bucketMs: number, count: number, now = Date.now()): UptimeBucket[] {
  const end = Math.ceil(now / bucketMs) * bucketMs;
  const buckets: UptimeBucket[] = Array.from({ length: count }, (_, i) => {
    const start = end - (count - i) * bucketMs;
    return { start, end: start + bucketMs, total: 0, ok: 0 };
  });
  const first = buckets[0].start;
  for (const s of samples) {
    if (s.at < first || s.at >= end) continue;
    const b = buckets[Math.floor((s.at - first) / bucketMs)];
    b.total += 1;
    if (s.ok) b.ok += 1;
  }
  return buckets;
}

export function availabilityPct(samples: UptimeSample[]): number | null {
  if (samples.length === 0) return null;
  return (samples.filter((s) => s.ok).length / samples.length) * 100;
}
