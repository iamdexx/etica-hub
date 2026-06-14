/**
 * Permissionless manual re-fold.
 *
 * Lets anyone with the labs UI click "Re-fold this RES" on a candidate
 * whose structure is pending. The endpoint:
 *   1. Looks up the candidate (by jobId + candidateIndex)
 *   2. Pushes a retry-queue entry with `nextRetryAt = now` so the next
 *      cron tick (within 5 min) picks it up
 *   3. Returns 202 immediately — the actual fold still happens in the
 *      cron drain, so we don't tie up an Edge function for ~90s
 *
 * Rate-limited per IP via the shared Labs limiter (5 / hour) so a script
 * can't drain the cron budget. Permissionless on wallet: a candidate's
 * own minter shouldn't be the only one who can heal it (treasury, peers,
 * whoever) since fold capacity is a community good.
 */

import type { NextRequest } from 'next/server';

import { getPdbForSequence } from '@/lib/labs/archive';
import {
  foldRetryQueue,
  makeFoldRetryEntryId,
} from '@/lib/labs/fold-retry-queue';
import type { LabsJob, LabsJobEvent } from '@/lib/labs/job';
import { labsQueue } from '@/lib/labs/queue';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);
  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  const { id: jobId } = await params;
  if (!jobId) {
    return json({ error: 'Job id is required.' }, { status: 400, headers: limit.headers });
  }

  let body: { candidateIndex?: unknown };
  try {
    body = (await req.json()) as { candidateIndex?: unknown };
  } catch {
    return json(
      { error: 'Invalid JSON payload.' },
      { status: 400, headers: limit.headers },
    );
  }

  const candidateIndex =
    typeof body.candidateIndex === 'number' && Number.isFinite(body.candidateIndex)
      ? Math.floor(body.candidateIndex)
      : -1;
  if (candidateIndex < 0) {
    return json(
      { error: 'candidateIndex is required.' },
      { status: 400, headers: limit.headers },
    );
  }

  const queue = labsQueue();
  const job = await queue.get(jobId);
  if (!job) {
    return json({ error: 'Job not found.' }, { status: 404, headers: limit.headers });
  }
  const candidate = job.result?.candidates.find((c) => c.index === candidateIndex);
  if (!candidate) {
    return json(
      { error: 'Candidate not found.' },
      { status: 404, headers: limit.headers },
    );
  }
  // Allow a re-fold when the candidate is still pending OR when it claims to
  // be folded but no structure is actually retrievable — inline on the job
  // result (only one is kept) nor in the per-sequence archive. This heals
  // pre-archive jobs whose per-candidate PDBs were dropped. If a structure
  // already exists, there's nothing to re-fold.
  if (!candidate.structurePending) {
    const inlinePdb = job.result?.pdbBySequenceIndex?.[candidateIndex];
    let hasStructure = typeof inlinePdb === 'string' && inlinePdb.length > 0;
    if (!hasStructure) {
      try {
        hasStructure = Boolean(await getPdbForSequence(candidate.sequence));
      } catch {
        hasStructure = false;
      }
    }
    if (hasStructure) {
      return json(
        { error: 'Candidate already has a folded structure.' },
        { status: 409, headers: limit.headers },
      );
    }
  }

  const retryQ = foldRetryQueue();
  const now = Date.now();
  const entryId = makeFoldRetryEntryId(jobId, candidateIndex);
  const existing = await retryQ.get(entryId);

  await retryQ.schedule({
    id: entryId,
    jobId,
    candidateIndex,
    sequence: candidate.sequence,
    firstQueuedAt: existing?.firstQueuedAt ?? now,
    // Schedule for the very next cron tick by setting nextRetryAt to now;
    // the drain endpoint pops anything <= now.
    nextRetryAt: now,
    // Reset the attempt counter so the manual re-fold gets a fresh budget.
    attempts: 0,
    lastError: existing?.lastError ?? candidate.error,
  });

  const event: LabsJobEvent = {
    at: now,
    kind: 're_fold_requested',
    message: `Manual re-fold requested for candidate ${candidateIndex}.`,
    meta: { index: candidateIndex },
  };
  const next: LabsJob = {
    ...job,
    updatedAt: now,
    events: [...job.events, event].slice(-200),
  };
  await queue.put(next);

  return json(
    {
      queued: true,
      jobId,
      candidateIndex,
      nextRetryAt: now,
    },
    { status: 202, headers: limit.headers },
  );
}
