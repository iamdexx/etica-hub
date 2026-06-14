/**
 * Fold retry cron drain.
 *
 * Pops every entry from `labs:fold-retry-queue` whose `nextRetryAt` has
 * fallen due, re-runs the fold cascade for each candidate, and patches
 * the originating Labs job's result in place — so a candidate that was
 * published with `structurePending: true` lights up with a real PDB the
 * next time NVIDIA / HF comes back up. Mint flow doesn't change; it
 * just sees fewer "Structure pending" badges over time.
 *
 * Auth: accepts EITHER Vercel's cron `x-vercel-cron` signal header OR
 * the worker token (so an operator can manually drain via curl). The
 * cron header is set automatically by Vercel for invocations defined in
 * `vercel.json` — anyone else hitting this endpoint needs the
 * `LABS_AUTOPILOT_TOKEN` secret.
 *
 * Idempotent: a successful retry removes the entry; a failed retry
 * reschedules it forward; an exhausted entry (12 attempts, ~18h budget)
 * is dropped from the queue so it never accumulates. The candidate
 * itself stays `structurePending: true` in the job blob — UI keeps the
 * manual "Re-fold this RES" button working.
 */

import type { NextRequest } from 'next/server';

import { getPdbForSequence, storePdbForSequence } from '@/lib/labs/archive';
import { foldWithCascade } from '@/lib/labs/engines/registry';
import {
  FOLD_RETRY_MAX_ATTEMPTS,
  foldRetryQueue,
  nextRetryDelayMs,
  type FoldRetryEntry,
} from '@/lib/labs/fold-retry-queue';
import type { LabsJob, LabsJobEvent, LabsJobResult } from '@/lib/labs/job';
import { labsQueue } from '@/lib/labs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Cap entries drained per cron tick. Each retry can spend up to ~90s. */
const MAX_PER_TICK = 5;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function authorize(req: NextRequest): boolean {
  // Vercel cron signal — present on every invocation Vercel makes from
  // its scheduler. Cron-only invocations don't need the worker token.
  if (req.headers.get('x-vercel-cron')) return true;

  const expected = process.env.LABS_AUTOPILOT_TOKEN;
  if (!expected) return false;
  const provided = req.headers.get('x-labs-worker-token');
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

type RetryReport = {
  id: string;
  jobId: string;
  candidateIndex: number;
  attempts: number;
  outcome: 'recovered' | 'rescheduled' | 'exhausted' | 'stale' | 'orphaned';
  engine?: string;
  error?: string;
};

async function processEntry(
  entry: FoldRetryEntry,
  now: number,
): Promise<RetryReport> {
  const queue = labsQueue();
  const retryQ = foldRetryQueue();

  const job = await queue.get(entry.jobId);
  if (!job) {
    // Job evicted (TTL / manual delete). Drop entry, nothing to patch.
    await retryQ.remove(entry.id);
    return {
      id: entry.id,
      jobId: entry.jobId,
      candidateIndex: entry.candidateIndex,
      attempts: entry.attempts,
      outcome: 'orphaned',
    };
  }

  const result = job.result;
  if (!result) {
    await retryQ.remove(entry.id);
    return {
      id: entry.id,
      jobId: entry.jobId,
      candidateIndex: entry.candidateIndex,
      attempts: entry.attempts,
      outcome: 'orphaned',
    };
  }

  const candidate = result.candidates.find((c) => c.index === entry.candidateIndex);
  if (!candidate) {
    // Candidate never existed. Drop.
    await retryQ.remove(entry.id);
    return {
      id: entry.id,
      jobId: entry.jobId,
      candidateIndex: entry.candidateIndex,
      attempts: entry.attempts,
      outcome: 'stale',
    };
  }
  // Process a candidate that's still pending OR one that claims to be folded
  // but has no retrievable structure (inline or archived) — the latter heals
  // pre-archive jobs. If a structure already exists, the entry is stale.
  if (!candidate.structurePending) {
    const inline = result.pdbBySequenceIndex?.[entry.candidateIndex];
    let hasStructure = typeof inline === 'string' && inline.length > 0;
    if (!hasStructure) {
      try {
        hasStructure = Boolean(await getPdbForSequence(entry.sequence));
      } catch {
        hasStructure = false;
      }
    }
    if (hasStructure) {
      await retryQ.remove(entry.id);
      return {
        id: entry.id,
        jobId: entry.jobId,
        candidateIndex: entry.candidateIndex,
        attempts: entry.attempts,
        outcome: 'stale',
      };
    }
  }

  const outcome = await foldWithCascade(entry.sequence);
  const nextAttempts = entry.attempts + 1;

  if (outcome.ok) {
    // Always persist the Cα trace to the per-sequence archive so the feed and
    // the NFT renderer can recover this candidate's structure even though only
    // one PDB is carried inline on the job result. Best-effort: never fail the
    // drain over an archive write.
    try {
      await storePdbForSequence(entry.sequence, outcome.pdb);
    } catch (err) {
      console.error('[labs] fold-retry archive write failed (non-fatal)', err);
    }

    // Only flip pending candidates inline (clear the badge + carry one PDB).
    // A candidate that was already folded but lost its structure is healed by
    // the archive write above — the feed lazy-fetches it — so we leave the job
    // blob's inline PDBs untouched to avoid re-bloating it (Redis OOM guard).
    const wasPending = candidate.structurePending === true;
    const patchedResult: LabsJobResult = wasPending
      ? {
          ...result,
          candidates: result.candidates.map((c) =>
            c.index === entry.candidateIndex
              ? {
                  ...c,
                  folded: true,
                  engine: outcome.engine,
                  structurePending: undefined,
                  error: undefined,
                }
              : c,
          ),
          pdbBySequenceIndex: {
            ...result.pdbBySequenceIndex,
            [entry.candidateIndex]: outcome.pdb,
          },
        }
      : result;
    const event: LabsJobEvent = {
      at: now,
      kind: 're_fold_completed',
      message: `Candidate ${entry.candidateIndex} re-folded on ${outcome.engine} after ${nextAttempts} retry attempt(s).`,
      meta: { index: entry.candidateIndex, engine: outcome.engine, attempts: nextAttempts },
    };
    const next: LabsJob = {
      ...job,
      updatedAt: now,
      events: [...job.events, event].slice(-200),
      result: patchedResult,
    };
    await queue.put(next);
    await retryQ.remove(entry.id);
    return {
      id: entry.id,
      jobId: entry.jobId,
      candidateIndex: entry.candidateIndex,
      attempts: nextAttempts,
      outcome: 'recovered',
      engine: outcome.engine,
    };
  }

  // Cascade still failing. Reschedule or give up.
  const delay = nextRetryDelayMs(nextAttempts);
  if (delay === null || nextAttempts >= FOLD_RETRY_MAX_ATTEMPTS) {
    await retryQ.remove(entry.id);
    const event: LabsJobEvent = {
      at: now,
      kind: 'note',
      message: `Fold retry budget exhausted for candidate ${entry.candidateIndex} after ${nextAttempts} attempts; structure pending until manual re-fold.`,
      meta: { index: entry.candidateIndex, attempts: nextAttempts },
    };
    const next: LabsJob = {
      ...job,
      updatedAt: now,
      events: [...job.events, event].slice(-200),
    };
    await queue.put(next);
    return {
      id: entry.id,
      jobId: entry.jobId,
      candidateIndex: entry.candidateIndex,
      attempts: nextAttempts,
      outcome: 'exhausted',
      error: outcome.error,
    };
  }

  await retryQ.schedule({
    ...entry,
    attempts: nextAttempts,
    nextRetryAt: now + delay,
    lastError: outcome.error,
  });
  return {
    id: entry.id,
    jobId: entry.jobId,
    candidateIndex: entry.candidateIndex,
    attempts: nextAttempts,
    outcome: 'rescheduled',
    error: outcome.error,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!authorize(req)) {
    return json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const retryQ = foldRetryQueue();
  const now = Date.now();
  const ready = await retryQ.popReady(now, MAX_PER_TICK);

  const reports: RetryReport[] = [];
  for (const entry of ready) {
    try {
      reports.push(await processEntry(entry, Date.now()));
    } catch (err) {
      console.error('[labs] fold-retry processEntry failed', err);
      reports.push({
        id: entry.id,
        jobId: entry.jobId,
        candidateIndex: entry.candidateIndex,
        attempts: entry.attempts,
        outcome: 'rescheduled',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const remaining = await retryQ.size();
  return json({ drained: reports.length, remaining, reports });
}

export const POST = GET;
