import { beforeEach, describe, expect, it } from 'vitest';

import { _resetLabsStoreForTests } from '@/lib/labs/store';
import {
  availabilityPct,
  bucketize,
  decodeSample,
  encodeSample,
  loadUptimeSamples,
  recordUptimeSample,
  type UptimeSample,
} from '@/lib/uptime';

const HOUR = 60 * 60 * 1000;

function sample(at: number, ok: boolean): UptimeSample {
  return { at, ok, headAgeSeconds: ok ? 12 : null, responseTimeMs: 300 };
}

describe('uptime samples', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.LABS_KV_REST_API_URL;
    _resetLabsStoreForTests();
  });

  it('round-trips through the encoded member format', () => {
    const s = sample(1_700_000_000_000, true);
    expect(decodeSample(encodeSample(s))).toEqual(s);
    const failed = sample(1_700_000_000_000, false);
    expect(decodeSample(encodeSample(failed))).toEqual(failed);
    expect(decodeSample('garbage')).toBeNull();
  });

  it('records and loads samples in chronological order, filtered by window', async () => {
    const now = Date.now();
    await recordUptimeSample(sample(now - 2 * HOUR, true));
    await recordUptimeSample(sample(now - 30 * 24 * HOUR, false));
    await recordUptimeSample(sample(now - HOUR, false));

    const all = await loadUptimeSamples(0);
    expect(all.map((s) => s.ok)).toEqual([false, true, false]);

    const recent = await loadUptimeSamples(now - 3 * HOUR);
    expect(recent).toHaveLength(2);
    expect(recent[0].at).toBeLessThan(recent[1].at);
  });

  it('bucketizes into fixed windows ending at now', () => {
    const now = 10 * HOUR + 15 * 60 * 1000;
    const samples = [sample(now - 10 * 60 * 1000, true), sample(now - HOUR - 1, false), sample(now - 5 * HOUR, true)];
    const buckets = bucketize(samples, HOUR, 3, now);
    expect(buckets).toHaveLength(3);
    expect(buckets[2]).toMatchObject({ total: 1, ok: 1 });
    expect(buckets[1]).toMatchObject({ total: 1, ok: 0 });
    expect(buckets[0]).toMatchObject({ total: 0, ok: 0 });
  });

  it('computes availability percentage', () => {
    expect(availabilityPct([])).toBeNull();
    expect(availabilityPct([sample(1, true), sample(2, true), sample(3, false), sample(4, true)])).toBe(75);
  });
});
