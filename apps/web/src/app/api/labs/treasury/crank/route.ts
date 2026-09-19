/**
 * POST /api/labs/treasury/crank — settle abandoned research to the treasury.
 *
 * Fired fire-and-forget on every platform mint (the user's own mint is just
 * the trigger signal — this runs as a separate keeper transaction, so the
 * user never pays for it) and as a safety-net pass on the autopilot tick.
 *
 * Bounded + idempotent: settles at most a handful of records per call and
 * relies on the contract's on-chain `branchClaimed` guard for dedupe, so it
 * is safe to call frequently and concurrently. Always returns 200 with a
 * summary; it never throws (research must never fail on anything).
 *
 * Optional body: { max?: number } — override the per-run settlement cap
 * (clamped 1..10).
 *
 * Public callers (the mint button) are rate-limited per IP so the keeper's
 * gas can't be griefed; the autopilot worker token bypasses the limit.
 */

import { NextRequest } from 'next/server';

import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import { runTreasuryCrank } from '@/lib/labs/treasury-crank';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

const PUBLIC_CRANKS_PER_HOUR = 10;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest): Promise<Response> {
  if (!requireWorkerAuth(req).ok) {
    const limit = await consumeLabsRateLimit(req, {
      scope: 'treasury-crank',
      limit: PUBLIC_CRANKS_PER_HOUR,
    });
    if (!limit.ok) {
      return Response.json(limit.body, { status: limit.status, headers: limit.headers });
    }
  }

  let max: number | undefined;
  try {
    const body = (await req.json()) as { max?: unknown };
    if (typeof body?.max === 'number' && Number.isFinite(body.max)) {
      max = body.max;
    }
  } catch {
    // no/invalid body — use defaults
  }

  const summary = await runTreasuryCrank({ max });
  return Response.json(summary);
}
