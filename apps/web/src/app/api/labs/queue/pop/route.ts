/**
 * Worker-only endpoint: pops the oldest pending Labs job and marks it
 * running. Used by the GitHub Actions autopilot worker on its cron tick.
 *
 * POST /api/labs/queue/pop
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   returns:
 *     - 200 { job: LabsJob }   — job dequeued, status transitioned to 'running'
 *     - 204 (no body)          — queue is empty
 *     - 401                    — bad / missing token
 *     - 503                    — token not configured (fail closed)
 */

import { NextRequest } from 'next/server';

import { appendJobEvent, labsQueue, withStatus } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  const queue = labsQueue();
  const id = await queue.popPending();
  if (!id) {
    return new Response(null, { status: 204 });
  }

  const job = await queue.get(id);
  if (!job) {
    return json(
      { error: `Popped job ${id} but blob is missing — skipping.` },
      { status: 410 },
    );
  }

  const running = appendJobEvent(withStatus(job, 'running'), {
    kind: 'started',
    message: 'Worker picked up job',
  });
  await queue.put(running);

  return json({ job: running });
}
