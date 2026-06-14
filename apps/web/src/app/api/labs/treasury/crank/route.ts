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
 */

import { NextRequest } from 'next/server';

import { runTreasuryCrank } from '@/lib/labs/treasury-crank';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest): Promise<Response> {
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
