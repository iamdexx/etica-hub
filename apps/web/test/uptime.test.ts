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

  it('bucketizes into fixed windows covering exactly the rolling interval', () => {
    const now = 10 * HOUR + 15 * 60 * 1000;
    const samples = [
      sample(now - 10 * 60 * 1000, true),
      sample(now - HOUR - 1, false),
      sample(now - 3 * HOUR + 1, true),
      sample(now - 5 * HOUR, true),
    ];
    const buckets = bucketize(samples, HOUR, 3, now);
    expect(buckets).toHaveLength(3);
    expect(buckets[0].start).toBe(now - 3 * HOUR);
    expect(buckets[2].end).toBe(now);
    expect(buckets[2]).toMatchObject({ total: 1, ok: 1 });
    expect(buckets[1]).toMatchObject({ total: 1, ok: 0 });
    expect(buckets[0]).toMatchObject({ total: 1, ok: 1 });
  });

  it('computes availability, counting missed cron slots as downtime', () => {
    const now = 100 * HOUR;
    const q = 15 * 60 * 1000;
    expect(availabilityPct([], now - HOUR, now, q)).toBeNull();

    const full = [1, 2, 3, 4].map((i) => sample(now - i * q, i !== 3));
    expect(availabilityPct(full, now - HOUR, now, q)).toBe(75);

    // 4 slots expected since first sample, only 2 recorded (app was down for 2 slots).
    const gappy = [sample(now - 4 * q, true), sample(now - q, true)];
    expect(availabilityPct(gappy, now - HOUR, now, q)).toBe(50);

    // History that only just started is not penalised for the pre-history window.
    expect(availabilityPct([sample(now - q, true)], now - 24 * HOUR, now, q)).toBe(100);
  });
});
