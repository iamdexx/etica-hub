/**
 * Worker-facing goal touch endpoint.
 *
 * POST /api/labs/goals/[id]/touch
 *   header: x-labs-worker-token = LABS_AUTOPILOT_TOKEN
 *   body:   { jobId: string, completed?: boolean }
 *
 * Called by the Autopilot worker after it finishes a goal-attached job
 * so the goal's runCount + lastRunAt reflect the new state. We
 * deliberately keep this lightweight — no cross-validation against the
 * job's status, since the worker is trusted.
 */
import { NextRequest } from 'next/server';

import { updateGoal } from '@/lib/labs/goal-store';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  const { id } = await ctx.params;
  let body: { completed?: unknown };
  try {
    body = (await req.json()) as { completed?: unknown };
  } catch {
    body = {};
  }
  const completed = body.completed === true;
  const updated = await updateGoal(id, {
    runCountDelta: completed ? 1 : 0,
    lastRunAt: Date.now(),
  });
  if (!updated) return json({ error: 'Goal not found.' }, { status: 404 });
  return json({ ok: true, runCount: updated.runCount, lastRunAt: updated.lastRunAt });
}
