/**
 * Worker-only endpoint: appends events + optional result + status to a
 * Labs job. Called repeatedly by the GitHub Actions autopilot worker as
 * iterations complete.
 *
 * POST /api/labs/queue/[id]/update
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   body: {
 *     events?: LabsJobEvent[],
 *     status?: LabsJobStatus,
 *     iterationsDelta?: number,
 *     result?: LabsJobResult,        // replaces existing result blob
 *   }
 *   returns: { job: LabsJob }
 */

import { NextRequest } from 'next/server';

import type { LabsJob, LabsJobEvent, LabsJobResult, LabsJobStatus } from '@/lib/labs/job';
import { labsQueue } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';
import {
  foldRetryQueue,
  makeFoldRetryEntryId,
  nextRetryDelayMs,
} from '@/lib/labs/fold-retry-queue';
import { archiveResearch, extractDisease, type ArchivedResearch } from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const VALID_STATUSES: LabsJobStatus[] = ['pending', 'running', 'done', 'error'];
const VALID_EVENT_KINDS = new Set([
  'queued',
  'started',
  'planned',
  'folded',
  'fold_attempt_failed',
  'structure_pending',
  're_fold_requested',
  're_fold_completed',
  'analysed',
  'mutated',
  'proteinmpnn',
  'proteinmpnn_fallback',
  'docking_ready',
  'sequence_rejected',
  'sequence_low_quality',
  'iteration_done',
  'completed',
  'error',
  'note',
  'goal_context',
]);
const MAX_EVENTS_PER_UPDATE = 50;
const MAX_PDB_PER_RESULT = 1;
const MAX_PDB_CHARS = 50_000; // ~50KB per PDB; trimmed beyond this
const MAX_ANALYSIS_CHARS = 4000;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function sanitizeEvents(raw: unknown): LabsJobEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: LabsJobEvent[] = [];
  for (const e of raw.slice(0, MAX_EVENTS_PER_UPDATE)) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const kind = typeof rec.kind === 'string' && VALID_EVENT_KINDS.has(rec.kind) ? rec.kind : null;
    const message = typeof rec.message === 'string' ? rec.message.slice(0, 800) : null;
    if (!kind || !message) continue;
    const meta: Record<string, string | number | boolean> = {};
    if (rec.meta && typeof rec.meta === 'object') {
      for (const [k, v] of Object.entries(rec.meta)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          meta[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 200) : v;
        }
      }
    }
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : Date.now();
    out.push({ at, kind: kind as LabsJobEvent['kind'], message, meta });
  }
  return out;
}

function sanitizeResult(raw: unknown): LabsJobResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const plan = rec.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== 'object') return undefined;

  const candidatesRaw = Array.isArray(rec.candidates) ? rec.candidates : [];
  const candidates: LabsJobResult['candidates'] = [];
  for (const c of candidatesRaw.slice(0, 10)) {
    if (!c || typeof c !== 'object') continue;
    const cr = c as Record<string, unknown>;
    const idx = typeof cr.index === 'number' ? cr.index : -1;
    const seq = typeof cr.sequence === 'string' ? cr.sequence.slice(0, 500) : '';
    const rationale = typeof cr.rationale === 'string' ? cr.rationale.slice(0, 800) : '';
    if (idx < 0 || !seq) continue;
    candidates.push({
      index: idx,
      sequence: seq,
      rationale,
      engine: typeof cr.engine === 'string' ? cr.engine.slice(0, 40) : undefined,
      folded: cr.folded === true,
      analysis:
        typeof cr.analysis === 'string' ? cr.analysis.slice(0, MAX_ANALYSIS_CHARS) : undefined,
      score:
        typeof cr.score === 'number' && Number.isFinite(cr.score)
          ? Math.max(0, Math.min(1, cr.score))
          : undefined,
      error: typeof cr.error === 'string' ? cr.error.slice(0, 400) : undefined,
      structurePending: cr.structurePending === true ? true : undefined,
    });
  }

  const pdbMap: Record<number, string> = {};
  const rawPdb = rec.pdbBySequenceIndex as Record<string, unknown> | undefined;
  if (rawPdb && typeof rawPdb === 'object') {
    let kept = 0;
    for (const [k, v] of Object.entries(rawPdb)) {
      if (kept >= MAX_PDB_PER_RESULT) break;
      const idx = Number(k);
      if (!Number.isFinite(idx) || idx < 0) continue;
      if (typeof v !== 'string') continue;
      pdbMap[idx] = v.length > MAX_PDB_CHARS ? v.slice(0, MAX_PDB_CHARS) : v;
      kept += 1;
    }
  }

  return {
    plan: {
      hypothesis: typeof plan.hypothesis === 'string' ? plan.hypothesis.slice(0, 600) : '',
      approach: typeof plan.approach === 'string' ? plan.approach.slice(0, 800) : '',
      successCriteria:
        typeof plan.successCriteria === 'string' ? plan.successCriteria.slice(0, 400) : '',
      risks: typeof plan.risks === 'string' ? plan.risks.slice(0, 400) : '',
      references: Array.isArray(plan.references)
        ? (plan.references as LabsJobResult['plan']['references']).slice(0, 12)
        : [],
    },
    candidates,
    pdbBySequenceIndex: pdbMap,
    summary: typeof rec.summary === 'string' ? rec.summary.slice(0, 1200) : undefined,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  const { id } = await params;
  if (!id) return json({ error: 'Job ID is required.' }, { status: 400 });

  let body: {
    events?: unknown;
    status?: unknown;
    iterationsDelta?: unknown;
    result?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const queue = labsQueue();

  let existing: LabsJob | null;
  try {
    existing = await queue.get(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[labs/update] queue.get failed for ${id}:`, msg);
    return json({ error: `queue.get failed: ${msg}` }, { status: 502 });
  }
  if (!existing) return json({ error: 'Job not found.' }, { status: 404 });

  const newEvents = sanitizeEvents(body.events);
  const statusUpdate =
    typeof body.status === 'string' && VALID_STATUSES.includes(body.status as LabsJobStatus)
      ? (body.status as LabsJobStatus)
      : existing.status;
  const iterationsDelta =
    typeof body.iterationsDelta === 'number' && Number.isFinite(body.iterationsDelta)
      ? Math.max(0, Math.floor(body.iterationsDelta))
      : 0;
  const result = sanitizeResult(body.result) ?? existing.result;

  const now = Date.now();
  const next: LabsJob = {
    ...existing,
    status: statusUpdate,
    iterations: existing.iterations + iterationsDelta,
    updatedAt: now,
    events: [...existing.events, ...newEvents].slice(-50),
    result,
  };

  try {
    await queue.put(next);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const payloadSize = JSON.stringify(next).length;
    console.error(`[labs/update] queue.put failed for ${id} (${payloadSize} bytes):`, msg);
    return json({ error: `queue.put failed (${payloadSize} bytes): ${msg}` }, { status: 502 });
  }

  // Auto-enqueue fold retries for any candidate the worker published
  // with `structurePending: true`. The cron at /api/labs/fold/retry
  // will drain the queue every 5 min and patch the candidate back in
  // place once a fold engine recovers. Best-effort — a retry-queue
  // failure must not break the worker update path.
  if (result?.candidates?.length) {
    try {
      const retryQ = foldRetryQueue();
      const retryNow = Date.now();
      const initialDelay = nextRetryDelayMs(1) ?? 5 * 60 * 1000;
      for (const c of result.candidates) {
        if (!c.structurePending) continue;
        const entryId = makeFoldRetryEntryId(id, c.index);
        const existingEntry = await retryQ.get(entryId);
        if (existingEntry) continue; // already scheduled
        await retryQ.schedule({
          id: entryId,
          jobId: id,
          candidateIndex: c.index,
          sequence: c.sequence,
          firstQueuedAt: retryNow,
          nextRetryAt: retryNow + initialDelay,
          attempts: 0,
          lastError: c.error,
        });
      }
    } catch (err) {
      console.error('[labs] fold-retry enqueue failed', err);
    }
  }

  // Archive completed research permanently when job transitions to 'done'.
  // This is fire-and-forget — a failure here must not break the worker.
  if (statusUpdate === 'done' && existing.status !== 'done' && result) {
    try {
      const bestCandidate = result.candidates.reduce(
        (best, c) => ((c.score ?? 0) > (best.score ?? 0) ? c : best),
        result.candidates[0]!,
      );
      const archived: ArchivedResearch = {
        id: `${id}-archive`,
        jobId: id,
        goalId: next.goalId,
        goalTitle: undefined, // populated by goal lookup if needed
        disease: undefined,
        prompt: next.prompt,
        completedAt: now,
        hypothesis: result.plan.hypothesis,
        approach: result.plan.approach,
        successCriteria: result.plan.successCriteria,
        bestCandidate: {
          index: bestCandidate.index,
          sequence: bestCandidate.sequence,
          rationale: bestCandidate.rationale,
          score: bestCandidate.score,
          analysis: bestCandidate.analysis,
          folded: bestCandidate.folded,
          engine: bestCandidate.engine,
        },
        candidates: result.candidates.map((c) => ({
          index: c.index,
          sequence: c.sequence,
          rationale: c.rationale,
          score: c.score,
          analysis: c.analysis,
          folded: c.folded,
          engine: c.engine,
        })),
        iterations: next.iterations,
        summary: result.summary ?? '',
        bestPdb: result.pdbBySequenceIndex?.[bestCandidate.index],
        references: result.plan.references.map((r) => `${r.source}:${r.id} ${r.title}`),
        minted: false,
        submitterWallet: next.submitterWallet,
      };

      // Try to resolve goal title and extract disease name
      if (next.goalId) {
        try {
          const goalStore = await import('@/lib/labs/goal-store');
          const goal = await goalStore.getGoal(next.goalId);
          if (goal) {
            archived.goalTitle = goal.title;
            archived.disease = extractDisease(goal.title);
            archived.parentGoalId = goal.parentGoalId;
          }
        } catch { /* non-fatal */ }
      }

      await archiveResearch(archived);
    } catch (err) {
      console.error('[labs] archive failed (non-fatal):', err);
    }
  }

  return json({ job: next });
}
