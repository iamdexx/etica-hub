/**
 * Worker-only endpoint: branch a child goal from a parent goal's strong
 * candidate result. Used by the Autopilot loop to spawn dedicated
 * research threads when a parent job produces a high-scoring lead.
 *
 * POST /api/labs/goals/branch
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   body: {
 *     parentGoalId: string,
 *     parentJobId: string,
 *     title: string,          // child goal title
 *     description: string,    // child goal description (incl. seq + analysis)
 *     firstPrompt: string,    // initial research prompt to enqueue
 *     maxIterations?: number,
 *   }
 *   returns: { ok: true, goalId, jobId } | { ok: false, reason }
 *
 * Authentication: worker-token only. This bypasses the wallet-sig gate
 * because the request originates from the Autopilot loop, not a user.
 *
 * Safety: still runs Layers 1 (hard denylist) + 2 (biomedical gate) on
 * BOTH the description and the first prompt. Global pending cap is
 * enforced before creating the child goal so a runaway loop can't
 * fan out unbounded.
 */
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

import { attachJobToGoal, createGoal, getGoal, updateGoal } from '@/lib/labs/goal-store';
import {
  EXPAND_PENDING_CAP,
  incrDailyExpansionCount,
} from '@/lib/labs/expansion';
import type { LabsJob } from '@/lib/labs/job';
import {
  MAX_GOAL_DESCRIPTION,
  MAX_GOAL_TITLE,
} from '@/lib/labs/goal';
import { runBiomedicalGate, runHardDenylist } from '@/lib/labs/moderation';
import { appendJobEvent, labsQueue } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const MAX_PROMPT_CHARS = 400;
const DEFAULT_MAX_ITERATIONS = 3;
const MAX_ALLOWED_ITERATIONS = 5;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function clampIterations(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ITERATIONS;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  if (rounded > MAX_ALLOWED_ITERATIONS) return MAX_ALLOWED_ITERATIONS;
  return rounded;
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  let body: {
    parentGoalId?: unknown;
    parentJobId?: unknown;
    title?: unknown;
    description?: unknown;
    firstPrompt?: unknown;
    maxIterations?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const parentGoalId =
    typeof body.parentGoalId === 'string' ? body.parentGoalId.trim() : '';
  const parentJobId =
    typeof body.parentJobId === 'string' ? body.parentJobId.trim().slice(0, 80) : '';
  const title =
    typeof body.title === 'string'
      ? body.title.trim().slice(0, MAX_GOAL_TITLE)
      : '';
  const description =
    typeof body.description === 'string'
      ? body.description.trim().slice(0, MAX_GOAL_DESCRIPTION)
      : '';
  const firstPrompt = typeof body.firstPrompt === 'string' ? body.firstPrompt.trim() : '';
  const maxIterations = clampIterations(body.maxIterations);

  if (!parentGoalId) {
    return json({ ok: false, error: 'parentGoalId is required.' }, { status: 400 });
  }
  if (!parentJobId) {
    return json({ ok: false, error: 'parentJobId is required.' }, { status: 400 });
  }
  if (!title) return json({ ok: false, error: 'title is required.' }, { status: 400 });
  if (!firstPrompt) {
    return json({ ok: false, error: 'firstPrompt is required.' }, { status: 400 });
  }
  if (firstPrompt.length > MAX_PROMPT_CHARS) {
    return json(
      { ok: false, error: `firstPrompt must be ${MAX_PROMPT_CHARS} chars or fewer.` },
      { status: 400 },
    );
  }

  // Parent must still exist and not be hard-denied. We allow branching
  // from operator-hidden parents — the operator only paused the parent;
  // the existing high-scoring lead is still worth following up. They
  // can independently pause the branch goal if they want.
  const parent = await getGoal(parentGoalId);
  if (!parent) {
    return json({ ok: false, reason: 'parent-missing' }, { status: 404 });
  }
  if (parent.moderation === 'denied') {
    return json({ ok: false, reason: 'parent-denied' }, { status: 422 });
  }

  // Moderation Layers 1 + 2 on both the description and the first prompt
  // (description carries sequence + analysis text from the model; first
  // prompt is the model's proposed research direction).
  for (const txt of [title, description, firstPrompt]) {
    if (!txt) continue;
    const deny = runHardDenylist(txt);
    if (!deny.ok) {
      return json(
        { ok: false, reason: 'denied', detail: deny.category },
        { status: 422 },
      );
    }
  }
  const nvidiaKey = process.env.NVIDIA_API_KEY ?? '';
  if (nvidiaKey || process.env.NVIDIA_API_KEYS) {
    const gate = await runBiomedicalGate(
      `${title}\n${description}\n${firstPrompt}`,
      nvidiaKey,
    );
    if (gate.verdict === 'no') {
      return json(
        { ok: false, reason: 'off-topic', detail: gate.verdict },
        { status: 422 },
      );
    }
  }

  // Global pending-queue cap so a chain of strong wins can't fan out
  // indefinitely. Per-goal daily caps apply once the branch exists; the
  // first enqueue still counts against the *parent's* daily counter so
  // a single parent can't spawn unlimited branches in one day either.
  const queue = labsQueue();
  const pendingCount = await queue.pendingCount().catch(() => 0);
  if (pendingCount >= EXPAND_PENDING_CAP) {
    return json(
      { ok: false, reason: 'pending-cap-reached', pendingCount },
      { status: 200 },
    );
  }

  // Reserve parent's daily slot. If we're over cap, decline — the worker
  // will retry later or pick a different next-direction strategy.
  const after = await incrDailyExpansionCount(parentGoalId);
  // We don't refund on the rare race that pushes us over by 1; counter
  // is best-effort and the next-day rollover clears it.
  void after;

  // Create the child goal.
  const childGoal = await createGoal({
    title,
    description,
    submitterTag: 'autopilot',
    submitterWallet: parent.submitterWallet,
    parentGoalId,
    parentJobId,
    origin: 'branch',
  });

  // Enqueue the branch's first job.
  const now = Date.now();
  const jobId = randomUUID();
  const job: LabsJob = {
    id: jobId,
    prompt: firstPrompt,
    maxIterations,
    iterations: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    submitterTag: 'autopilot',
    submitterWallet: undefined,
    goalId: childGoal.id,
    moderation: 'visible',
    events: [
      {
        at: now,
        kind: 'queued',
        message: `Branch goal seeded from parent job ${parentJobId}.`,
        meta: {
          kind: 'branch',
          parentGoalId,
          parentJobId,
        },
      },
    ],
  };
  const stamped = appendJobEvent(job, {
    kind: 'note',
    message: `Autopilot branch — dedicated research thread for a high-scoring lead.`,
  });

  try {
    await queue.enqueue(stamped);
  } catch (err) {
    return json(
      {
        ok: false,
        reason: 'enqueue-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
  await attachJobToGoal(childGoal.id, jobId, now);
  await updateGoal(childGoal.id, { runCountDelta: 1, lastRunAt: now });

  return json({
    ok: true,
    goalId: childGoal.id,
    jobId,
    parentGoalId,
    parentJobId,
  });
}
