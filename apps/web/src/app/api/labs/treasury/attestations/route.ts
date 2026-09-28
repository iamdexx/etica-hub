/**
 * POST /api/labs/treasury/attestations — signed force-mint attestations
 * for abandoned research, for a keeper that pays its own gas.
 *
 * The in-process crank (/api/labs/treasury/crank) can only settle records
 * while the platform's own wallet holds EGAZ. This endpoint splits the two
 * halves: the platform keeps the attestor key and signs, an external
 * keeper (the same funded EOA that runs the daily farm harvest) submits
 * `claim()` and pays gas.
 *
 * Handing out an attestation grants nothing: past the 7-day window the
 * contract force-mints to the treasury regardless of who submits it, and
 * waives the fee. Public callers are rate-limited so signing can't be used
 * as a free CPU sink; the worker token bypasses the limit.
 *
 * Optional body: { max?: number } — attestations to return (clamped 1..25).
 */

import { NextRequest } from 'next/server';

import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import { listForfeitAttestations } from '@/lib/labs/treasury-crank';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

const PUBLIC_REQUESTS_PER_HOUR = 30;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<Response> {
  if (!requireWorkerAuth(req).ok) {
    const limit = await consumeLabsRateLimit(req, {
      scope: 'treasury-attestations',
      limit: PUBLIC_REQUESTS_PER_HOUR,
    });
    if (!limit.ok) {
      return Response.json(limit.body, { status: limit.status, headers: limit.headers });
    }
  }

  let max: number | undefined;
  try {
    const body = (await req.json()) as { max?: unknown };
    if (typeof body?.max === 'number' && Number.isFinite(body.max)) max = body.max;
  } catch {
    // no/invalid body — use defaults
  }

  try {
    return Response.json(await listForfeitAttestations({ max }));
  } catch (err) {
    return Response.json(
      { attestations: [], reason: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
