import { NextRequest, NextResponse } from 'next/server';
import { isVercelCron } from '@/lib/cron-auth';
import { computeHealth } from '@/lib/health';
import { buildTelemetrySnapshot } from '@/lib/telemetry/snapshot';
import { recordUptimeSample } from '@/lib/uptime';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const [snapshot, health] = await Promise.all([
    buildTelemetrySnapshot(),
    isVercelCron(req) ? computeHealth() : Promise.resolve(null),
  ]);

  if (health) {
    try {
      await recordUptimeSample({
        at: Date.now(),
        ok: health.ok,
        headAgeSeconds: health.headAgeSeconds,
        responseTimeMs: health.responseTimeMs,
      });
    } catch (err) {
      console.error('[telemetry] uptime sample failed:', err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  });
}
