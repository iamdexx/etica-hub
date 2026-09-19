/**
 * GET /api/v1/uptime
 *
 * 7-day availability history sampled by the telemetry cron (every 15 min).
 * Returns raw samples plus 24h / 7d availability percentages.
 */

import { jsonResponse } from '@/lib/priceApi';
import { availabilityPct, loadUptimeSamples } from '@/lib/uptime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(): Promise<Response> {
  const now = Date.now();
  const samples = await loadUptimeSamples(now - 7 * DAY_MS);
  const last24h = samples.filter((s) => s.at >= now - DAY_MS);

  return jsonResponse(
    {
      asOf: new Date(now).toISOString(),
      sampleIntervalMinutes: 15,
      availability24h: availabilityPct(last24h),
      availability7d: availabilityPct(samples),
      samples,
    },
    { headers: { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=120' } },
  );
}
