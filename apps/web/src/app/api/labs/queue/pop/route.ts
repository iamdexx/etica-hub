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

import { getStatus } from '@/lib/labs/moderation-store';
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
  // Skip jobs that are hidden / denied / operator-hidden so workers never
  // process them. We pop up to 8 candidates per tick before giving up.
  for (let i = 0; i < 8; i++) {
    const id = await queue.popPending();
    if (!id) return new Response(null, { status: 204 });

    const job = await queue.get(id);
    if (!job) continue;

    const modStatus = await getStatus('job', id).catch(() => 'visible');
    if (
      modStatus === 'hidden' ||
      modStatus === 'denied' ||
      modStatus === 'operator-hidden'
    ) {
      const skipped = appendJobEvent(withStatus(job, 'error'), {
        kind: 'skipped',
        message: `Skipped by moderation (${modStatus})`,
      });
      await queue.put(skipped);
      continue;
    }

    const running = appendJobEvent(withStatus(job, 'running'), {
      kind: 'started',
      message: 'Worker picked up job',
    });
    await queue.put(running);
    return json({ job: running });
  }
  return new Response(null, { status: 204 });
}
