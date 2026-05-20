/**
 * Worker-only endpoint: finds "running" jobs that have been stuck for
 * longer than a threshold and requeues them as "pending".
 *
 * POST /api/labs/queue/requeue-stale
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   body: { maxAgeMs?: number }   — default 10 minutes
 *   returns: { requeued: string[] }
 */

import { NextRequest } from 'next/server';

import { appendJobEvent, labsQueue, withStatus } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  let maxAgeMs = DEFAULT_MAX_AGE_MS;
  try {
    const body = (await req.json()) as { maxAgeMs?: number };
    if (typeof body.maxAgeMs === 'number' && body.maxAgeMs > 0) {
      maxAgeMs = body.maxAgeMs;
    }
  } catch {
    // use default
  }

  const queue = labsQueue();
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  // Get recent feed entries and check for stuck "running" jobs
  const entries = await queue.recent(50);
  const requeued: string[] = [];

  for (const entry of entries) {
    if (entry.status !== 'running') continue;
    const job = await queue.get(entry.id);
    if (!job) continue;
    if (job.status !== 'running') continue;
    if (job.updatedAt > cutoff) continue; // still fresh, skip

    // Reset to pending and re-add to the pending queue
    const reset = appendJobEvent(withStatus(job, 'pending'), {
      kind: 'note',
      message: `Requeued: stuck in running for ${Math.round((now - job.updatedAt) / 1000)}s`,
    });
    await queue.enqueue(reset);
    requeued.push(job.id);
  }

  return json({ requeued, count: requeued.length });
}
