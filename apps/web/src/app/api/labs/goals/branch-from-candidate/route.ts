/**
 * User-facing endpoint: branch a child goal from a candidate on a
 * completed/running parent job.
 *
 * POST /api/labs/goals/branch-from-candidate
 *   body: {
 *     parentJobId: string,
 *     candidateIndex: number,
 *     prompt: string,            // first-job prompt for the new branch
 *     wallet: 0x..., signature: 0x..., issuedAt: number,
 *   }
 *   returns: { goalId, jobId } | { error }
 *
 * Wallet signs a `submit-job` message with payload
 *   `branch:${parentJobId}#${candidateIndex}|${prompt}`
 * so the signature is bound to the exact lead being branched.
 *
 * Safety:
 *   - Per-IP rate-limit (shared labs limiter, 5/hr)
 *   - Layer 1 (hard denylist) + Layer 2 (biomedical gate) on combined text
 *   - Global pending-queue cap (EXPAND_PENDING_CAP) to bound fan-out
 *   - Per-parent daily expansion counter (reuses worker cap so manual
 *     branches share budget with autopilot's own strong-score branches)
 *   - Refuses to branch from a denied parent goal/job
 */
import { createHash, randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

import {
  attachJobToGoal,
  createGoal,
  getGoal,
  updateGoal,
} from '@/lib/labs/goal-store';
import {
  EXPAND_PENDING_CAP,
  incrDailyExpansionCount,
} from '@/lib/labs/expansion';
import {
  MAX_GOAL_DESCRIPTION,
  MAX_GOAL_TITLE,
} from '@/lib/labs/goal';
import type { LabsJob } from '@/lib/labs/job';
import { runBiomedicalGate, runHardDenylist } from '@/lib/labs/moderation';
import { getStatus } from '@/lib/labs/moderation-store';
import { consumeLabsRateLimit, getClientIp } from '@/lib/labs/rate-limit';
import { appendJobEvent, labsQueue } from '@/lib/labs/queue';
import { verifySubmitPayload } from '@/lib/labs/submit-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const MAX_PROMPT_CHARS = 400;
const DEFAULT_MAX_ITERATIONS = 3;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function submitterTag(req: NextRequest): string {
  const ip = getClientIp(req);
  if (!ip || ip === 'unknown') return 'anon';
  return createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);
  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  let body: {
    parentJobId?: unknown;
    candidateIndex?: unknown;
    prompt?: unknown;
    wallet?: unknown;
    signature?: unknown;
    issuedAt?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(
      { error: 'Invalid JSON payload.' },
      { status: 400, headers: limit.headers },
    );
  }

  const parentJobId =
    typeof body.parentJobId === 'string' ? body.parentJobId.trim() : '';
  const candidateIndex =
    typeof body.candidateIndex === 'number' &&
    Number.isFinite(body.candidateIndex)
      ? Math.floor(body.candidateIndex)
      : -1;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!parentJobId) {
    return json(
      { error: 'parentJobId is required.' },
      { status: 400, headers: limit.headers },
    );
  }
  if (candidateIndex < 0) {
    return json(
      { error: 'candidateIndex is required.' },
      { status: 400, headers: limit.headers },
    );
  }
  if (!prompt) {
    return json(
      { error: 'Prompt is required.' },
      { status: 400, headers: limit.headers },
    );
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(
      { error: `Prompt must be ${MAX_PROMPT_CHARS} characters or fewer.` },
      { status: 400, headers: limit.headers },
    );
  }

  const signedPayload = `branch:${parentJobId}#${candidateIndex}|${prompt}`;
  const auth = await verifySubmitPayload({
    action: 'submit-job',
    payload: signedPayload,
    wallet: typeof body.wallet === 'string' ? body.wallet : '',
    signature: typeof body.signature === 'string' ? body.signature : '',
    issuedAt: typeof body.issuedAt === 'number' ? body.issuedAt : 0,
  });
  if (!auth.ok) {
    return json(
      { error: auth.error },
      { status: auth.status, headers: limit.headers },
    );
  }

  const queue = labsQueue();
  const parentJob = await queue.get(parentJobId).catch(() => null);
  if (!parentJob) {
    return json(
      { error: 'Parent job not found.' },
      { status: 404, headers: limit.headers },
    );
  }
  const candidate = parentJob.result?.candidates.find(
    (c) => c.index === candidateIndex,
  );
  if (!candidate) {
    return json(
      { error: 'Candidate not found on parent job.' },
      { status: 404, headers: limit.headers },
    );
  }

  // Parent goal — branching anchors the cascade to a research chain.
  // Legacy jobs (pre persistent-goals) may have no goalId; in that
  // case we synthesise a root goal from the parent prompt so the
  // child has somewhere to root, attach the parent to it, and proceed.
  let parentGoalId = parentJob.goalId;
  let parentGoal = parentGoalId
    ? await getGoal(parentGoalId).catch(() => null)
    : null;
  if (!parentGoalId || !parentGoal) {
    const seedTitle = clamp(parentJob.prompt.trim() || 'Legacy research job', MAX_GOAL_TITLE);
    const seedDescription = clamp(
      [
        'Auto-rooted goal for a legacy autopilot job that predates persistent goals.',
        `Original prompt: ${parentJob.prompt.trim()}`,
      ].join('\n\n'),
      MAX_GOAL_DESCRIPTION,
    );
    const synthetic = await createGoal({
      title: seedTitle,
      description: seedDescription,
      submitterTag: parentJob.submitterTag ?? submitterTag(req),
      submitterWallet: parentJob.submitterWallet,
      origin: 'user',
    });
    parentGoalId = synthetic.id;
    parentGoal = synthetic;
    const attachedAt = parentJob.updatedAt ?? Date.now();
    await attachJobToGoal(synthetic.id, parentJob.id, attachedAt).catch(() => {});
    await queue
      .put({ ...parentJob, goalId: synthetic.id })
      .catch(() => undefined);
  }
  const parentStatus = await getStatus('goal', parentGoal.id).catch(
    () => parentGoal.moderation,
  );
  if (parentStatus === 'denied') {
    return json(
      { error: 'Parent goal is denied.' },
      { status: 422, headers: limit.headers },
    );
  }

  // Moderation Layers 1 + 2 — defensive even though the parent already
  // passed: the user-typed prompt is fresh content.
  const sequenceSnippet = clamp(candidate.sequence, 200);
  const analysisSnippet = candidate.analysis
    ? clamp(candidate.analysis, 500)
    : '';
  const combined = `${prompt}\n${sequenceSnippet}\n${analysisSnippet}`;
  const deny = runHardDenylist(combined);
  if (!deny.ok) {
    return json(
      {
        error:
          'This branch is outside the scope of EticaLabs. Submissions are limited to biomedical and life-sciences research.',
      },
      { status: 403, headers: limit.headers },
    );
  }
  const groqKey = process.env.GROQ_API_KEY ?? '';
  if (groqKey || process.env.GROQ_API_KEYS) {
    const gate = await runBiomedicalGate(combined, groqKey);
    if (gate.verdict !== 'yes') {
      return json(
        {
          error:
            gate.verdict === 'no'
              ? 'EticaLabs branches must be biomedical or life-sciences research.'
              : 'Could not confirm this is a biomedical branch. Add more detail.',
        },
        { status: 403, headers: limit.headers },
      );
    }
  }

  // Global pending cap so a chain of branches can't fan out unbounded.
  const pendingCount = await queue.pendingCount().catch(() => 0);
  if (pendingCount >= EXPAND_PENDING_CAP) {
    return json(
      {
        error: 'Autopilot is at capacity. Try again in a few minutes.',
        pendingCount,
      },
      { status: 503, headers: limit.headers },
    );
  }

  // Reserve a daily-expansion slot against the parent goal so manual
  // branches share budget with the worker's strong-score branches.
  await incrDailyExpansionCount(parentGoalId).catch(() => 0);

  const branchTitle = clamp(
    `Branch — ${parentGoal.title}`,
    MAX_GOAL_TITLE,
  );
  const branchDescription = clamp(
    [
      `Branched from ${parentGoal.title} (parent job ${parentJobId}, candidate #${candidateIndex + 1}).`,
      candidate.rationale ? `Parent rationale: ${candidate.rationale}` : '',
      sequenceSnippet ? `Parent sequence (${candidate.sequence.length} aa): ${sequenceSnippet}` : '',
      analysisSnippet ? `Parent analysis: ${analysisSnippet}` : '',
      `User branch prompt: ${prompt}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    MAX_GOAL_DESCRIPTION,
  );

  const childGoal = await createGoal({
    title: branchTitle,
    description: branchDescription,
    submitterTag: submitterTag(req),
    submitterWallet: auth.wallet,
    parentGoalId,
    parentJobId,
    origin: 'branch',
  });

  const now = Date.now();
  const jobId = randomUUID();
  const job: LabsJob = {
    id: jobId,
    prompt,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    iterations: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    submitterTag: submitterTag(req),
    submitterWallet: auth.wallet,
    goalId: childGoal.id,
    moderation: 'visible',
    events: [
      {
        at: now,
        kind: 'queued',
        message: `Branch goal seeded from parent job ${parentJobId} candidate #${candidateIndex + 1}.`,
        meta: {
          kind: 'branch',
          parentGoalId,
          parentJobId,
          candidateIndex,
        },
      },
    ],
  };
  const stamped = appendJobEvent(job, {
    kind: 'note',
    message: 'User branch — dedicated research thread for a chosen RES candidate.',
  });

  try {
    await queue.enqueue(stamped);
  } catch (err) {
    return json(
      {
        error: 'Failed to enqueue branch job.',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503, headers: limit.headers },
    );
  }
  await attachJobToGoal(childGoal.id, jobId, now).catch(() => {});
  await updateGoal(childGoal.id, { runCountDelta: 1, lastRunAt: now }).catch(
    () => {},
  );

  return json(
    {
      ok: true,
      goalId: childGoal.id,
      jobId,
      parentGoalId,
      parentJobId,
      candidateIndex,
    },
    { status: 201, headers: limit.headers },
  );
}
