/**
 * Worker/admin endpoint: requeues jobs that ended in "error" back to
 * "pending" so the (now-fixed) pipeline reprocesses them.
 *
 * No data is removed — the job's events, results, and metadata are kept
 * intact; only the status flips error -> pending and a note event is
 * appended. The original createdAt is preserved so feed ordering is stable.
 *
 * POST /api/labs/queue/requeue-errored
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   body: { ids?: string[]; limit?: number }
 *     - ids:   requeue only these job IDs (must currently be in "error")
 *     - limit: how many recent feed entries to scan (default 50, max 50)
 *   returns: { requeued: string[], count: number,
 *             skipped: string[], skippedCount: number }
 *
 * Each requeue bumps the job's `requeueCount`; once it reaches
 * MAX_REQUEUE_ATTEMPTS the job is left in "error" (data intact) and
 * reported under `skipped` instead of looping forever.
 */

import { NextRequest } from 'next/server';

import { appendJobEvent, labsQueue, withStatus } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Max number of automatic error -> pending requeues per job. A job that
 * keeps failing (e.g. a genuinely un-foldable sequence) would otherwise
 * loop error -> pending -> error every tick forever, spending the 40 RPM
 * Nvidia budget on work that never succeeds. After this many attempts the
 * job is left in `error` (its data intact) and skipped. An explicit
 * `ids` request still honours the cap so the loop can't be re-armed by a
 * stray manual call.
 */
const MAX_REQUEUE_ATTEMPTS = 3;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  let ids: string[] | undefined;
  let limit = 50;
  try {
    const body = (await req.json()) as { ids?: string[]; limit?: number };
    if (Array.isArray(body.ids)) {
      ids = body.ids.filter((x): x is string => typeof x === 'string');
    }
    if (typeof body.limit === 'number' && body.limit > 0) {
      limit = Math.min(50, Math.floor(body.limit));
    }
  } catch {
    // use defaults
  }

  const queue = labsQueue();

  // Determine the candidate job IDs to inspect.
  let candidateIds: string[];
  if (ids && ids.length > 0) {
    candidateIds = ids;
  } else {
    const entries = await queue.recent(limit);
    candidateIds = entries.filter((e) => e.status === 'error').map((e) => e.id);
  }

  const requeued: string[] = [];
  const skipped: string[] = [];
  for (const id of candidateIds) {
    const job = await queue.get(id);
    if (!job) continue;
    if (job.status !== 'error') continue; // only touch errored jobs

    const priorAttempts = job.requeueCount ?? 0;
    if (priorAttempts >= MAX_REQUEUE_ATTEMPTS) {
      // Persistently failing — leave it in `error` (data intact) instead of
      // looping it back through the pipeline forever.
      skipped.push(job.id);
      continue;
    }

    // Flip error -> pending, preserving all events/results, and append a note.
    const attempt = priorAttempts + 1;
    const reset = appendJobEvent(
      withStatus({ ...job, requeueCount: attempt }, 'pending'),
      {
        kind: 'note',
        message: `Requeued from error (attempt ${attempt}/${MAX_REQUEUE_ATTEMPTS}) — reprocessing with the current pipeline (no data removed).`,
      },
    );
    await queue.enqueue(reset);
    requeued.push(job.id);
  }

  return json({ requeued, count: requeued.length, skipped, skippedCount: skipped.length });
}
