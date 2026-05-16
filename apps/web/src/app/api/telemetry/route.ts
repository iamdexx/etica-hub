import { NextResponse } from 'next/server';
import { buildTelemetrySnapshot } from '@/lib/telemetry/snapshot';

export async function GET() {
  const snapshot = await buildTelemetrySnapshot();

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  });
}
