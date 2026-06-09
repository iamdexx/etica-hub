/**
 * Worker-only endpoint: enqueue a system-originated follow-up job
 * spawned by the Autopilot loop when a prior job completes. Used to
 * drive the self-perpetuating research loop (auto-expansion +
 * cross-goal seeding).
 *
 * POST /api/labs/queue/spawn
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   body: {
 *     goalId: string,
 *     prompt: string,
 *     parentJobId?: string,
 *     kind?: 'continuation' | 'cross-goal',
 *     maxIterations?: number,
 *   }
 *   returns: { ok: true, id } | { ok: false, reason: <ExpansionDenyReason> }
 *
 * This bypasses the wallet-sig gate because the request is
 * authenticated by the worker token. Moderation layers 1 (denylist)
 * and 2 (biomedical gate) STILL apply — the worker-generated prompt
 * is still classified before enqueue, so a misbehaving model cannot
 * smuggle off-scope work into the pipeline.
 */

import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

import { attachJobToGoal, getGoal, updateGoal } from '@/lib/labs/goal-store';
import {
  evaluateExpansion,
  getDailyExpansionCount,
  incrDailyExpansionCount,
} from '@/lib/labs/expansion';
import type { LabsJob } from '@/lib/labs/job';
import { runBiomedicalGate, runHardDenylist } from '@/lib/labs/moderation';
import { appendJobEvent, labsQueue } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

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
    goalId?: unknown;
    prompt?: unknown;
    parentJobId?: unknown;
    kind?: unknown;
    maxIterations?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const goalId = typeof body.goalId === 'string' ? body.goalId.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const kind = body.kind === 'cross-goal' ? 'cross-goal' : 'continuation';
  const parentJobId =
    typeof body.parentJobId === 'string' ? body.parentJobId.trim().slice(0, 80) : undefined;
  const maxIterations = clampIterations(body.maxIterations);

  if (!goalId) return json({ ok: false, error: 'goalId is required.' }, { status: 400 });
  if (!prompt) return json({ ok: false, error: 'prompt is required.' }, { status: 400 });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(
      { ok: false, error: `prompt must be ${MAX_PROMPT_CHARS} chars or fewer.` },
      { status: 400 },
    );
  }

  // Layer 1 — hard denylist. Worker prompts are model-generated, so we
  // still scan them: a misbehaving model could surface forbidden terms.
  const deny = runHardDenylist(prompt);
  if (!deny.ok) {
    return json(
      { ok: false, reason: 'denied', detail: deny.category },
      { status: 422 },
    );
  }

  // Layer 2 — biomedical gate. Cheap Groq call; fail-closed if Groq is down.
  const nvidiaKey = process.env.NVIDIA_API_KEY ?? '';
  if (nvidiaKey || process.env.NVIDIA_API_KEYS) {
    const gate = await runBiomedicalGate(prompt, nvidiaKey);
    if (gate.verdict === 'no') {
      return json(
        { ok: false, reason: 'off-topic', detail: gate.verdict },
        { status: 422 },
      );
    }
  }

  // Caps gate — operator pause, daily-per-goal cap, global pending cap.
  const goal = await getGoal(goalId);
  const queue = labsQueue();
  const [dailyCount, pendingCount] = await Promise.all([
    getDailyExpansionCount(goalId),
    queue.pendingCount().catch(() => 0),
  ]);
  const decision = evaluateExpansion(goal, dailyCount, pendingCount);
  if (!decision.allowed) {
    return json(
      {
        ok: false,
        reason: decision.reason,
        dailyCount,
        pendingCount,
      },
      { status: 200 }, // 200 with ok:false — worker logs and moves on, not an error
    );
  }

  // Reserve the daily slot first (atomic incr) so concurrent spawn
  // calls can't both squeeze under the cap.
  const after = await incrDailyExpansionCount(goalId);
  if (after > 0 && goal && after > 6 + 0) {
    // (Counter may exceed cap by 1 in a race — best-effort, no refund.)
  }

  const now = Date.now();
  const id = randomUUID();
  const job: LabsJob = {
    id,
    prompt,
    maxIterations,
    iterations: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    submitterTag: 'autopilot',
    submitterWallet: undefined,
    goalId,
    moderation: 'visible',
    events: [
      {
        at: now,
        kind: 'queued',
        message:
          kind === 'cross-goal'
            ? `Cross-goal expansion seeded from job ${parentJobId ?? 'unknown'}.`
            : `Continuation seeded from job ${parentJobId ?? 'unknown'}.`,
        meta: {
          kind,
          ...(parentJobId ? { parentJobId } : {}),
        },
      },
    ],
  };
  const stamped = appendJobEvent(job, {
    kind: 'note',
    message: `Autopilot expansion (#${after} today on this goal).`,
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
  await attachJobToGoal(goalId, id, now);
  await updateGoal(goalId, { runCountDelta: 1, lastRunAt: now });

  return json({ ok: true, id, dailyCount: after, kind });
}
