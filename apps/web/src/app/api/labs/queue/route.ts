/**
 * Labs Autopilot submission endpoint.
 *
 * POST /api/labs/queue
 *   body: { prompt: string, maxIterations?: number }
 *   returns: { id, status: 'pending', queuedAhead, createdAt }
 *
 * GET /api/labs/queue
 *   returns: { entries: LabsFeedEntry[], pending: number }
 *
 * Fully open per product decision: any submission runs. Abuse is bounded
 * by the existing labs IP rate-limit (5/hr per IP) and by Redis free-tier
 * command caps. Content moderation happens implicitly at planning time
 * (Groq's safety filter will refuse harmful prompts; the worker logs and
 * moves on).
 */

import { createHash, randomUUID } from 'crypto';
import { NextRequest } from 'next/server';

import { attachJobToGoal, createGoal, getGoal } from '@/lib/labs/goal-store';
import type { LabsJob } from '@/lib/labs/job';
import { runBiomedicalGate, runHardDenylist } from '@/lib/labs/moderation';
import { getStatus } from '@/lib/labs/moderation-store';
import { consumeLabsRateLimit, getClientIp } from '@/lib/labs/rate-limit';
import { appendJobEvent, labsQueue } from '@/lib/labs/queue';
import { verifySubmitPayload } from '@/lib/labs/submit-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const MAX_PROMPT_CHARS = 400;
const DEFAULT_MAX_ITERATIONS = 3;
const MAX_ALLOWED_ITERATIONS = 5;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function submitterTag(req: NextRequest): string {
  const ip = getClientIp(req);
  if (!ip || ip === 'unknown') return 'anon';
  return createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

function clampIterations(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ITERATIONS;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  if (rounded > MAX_ALLOWED_ITERATIONS) return MAX_ALLOWED_ITERATIONS;
  return rounded;
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);
  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  let body: {
    prompt?: unknown;
    maxIterations?: unknown;
    goalId?: unknown;
    wallet?: unknown;
    signature?: unknown;
    issuedAt?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return json({ error: 'Prompt is required.' }, { status: 400, headers: limit.headers });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(
      { error: `Prompt must be ${MAX_PROMPT_CHARS} characters or fewer.` },
      { status: 400, headers: limit.headers },
    );
  }

  // Wallet-sig submission gate — every job is recorded with the
  // submitting wallet for the public moderation log. No token balance
  // requirement; only proof of address control. Moderation (flag/vouch)
  // separately requires ≥ 100 stETX.
  const auth = await verifySubmitPayload({
    action: 'submit-job',
    payload:
      typeof body.goalId === 'string' && body.goalId.trim()
        ? `${body.goalId.trim()}|${prompt}`
        : prompt,
    wallet: typeof body.wallet === 'string' ? body.wallet : '',
    signature: typeof body.signature === 'string' ? body.signature : '',
    issuedAt: typeof body.issuedAt === 'number' ? body.issuedAt : 0,
  });
  if (!auth.ok) {
    return json({ error: auth.error }, { status: auth.status, headers: limit.headers });
  }
  const submitterWallet = auth.wallet;

  // Layer 1: hard denylist — sync, instant rejection, terminal.
  const deny = runHardDenylist(prompt);
  if (!deny.ok) {
    return json(
      {
        error:
          'This submission is outside the scope of EticaLabs. Submissions are limited to biomedical and life-sciences research.',
      },
      { status: 403, headers: limit.headers },
    );
  }

  // Optional parent goal. Reject if the goal id was provided but doesn't
  // resolve to a visible goal (hidden / denied goals cannot accept new runs).
  let goalId: string | undefined;
  if (typeof body.goalId === 'string' && body.goalId.trim()) {
    const goal = await getGoal(body.goalId.trim()).catch(() => null);
    if (!goal) {
      return json({ error: 'Goal not found.' }, { status: 404, headers: limit.headers });
    }
    const liveStatus = await getStatus('goal', goal.id).catch(() => goal.moderation);
    if (liveStatus !== 'visible' && liveStatus !== 'operator-approved') {
      return json(
        { error: 'Goal is not accepting new runs (moderation hold).' },
        { status: 403, headers: limit.headers },
      );
    }
    goalId = goal.id;
  }

  // Layer 2: biomedical-scope gate via Nvidia Nemotron. Skipped for goal-attached
  // runs (the parent goal already passed the gate at creation time, and
  // the worker prompt-hardens follow-up iterations).
  if (!goalId) {
    const apiKey = process.env.NVIDIA_API_KEY ?? '';
    if (apiKey || process.env.NVIDIA_API_KEYS) {
      const gate = await runBiomedicalGate(prompt, apiKey);
      if (gate.verdict === 'no') {
        return json(
          {
            error: 'EticaLabs is for biomedical and life-sciences research. Please refine your prompt to a medical or biological objective.',
          },
          { status: 403, headers: limit.headers },
        );
      }
    }
  }

  const submitter = submitterTag(req);

  // Auto-root: top-level submits without an explicit goalId get a fresh
  // root goal synthesised from the prompt so every job shows up under
  // a topic on /labs/feed. Skips when the caller already nominated a
  // goal (e.g. branch / goal-detail submit paths).
  if (!goalId) {
    try {
      const rootGoal = await createGoal({
        title: prompt,
        description: '',
        submitterTag: submitter,
        submitterWallet,
        origin: 'user',
      });
      goalId = rootGoal.id;
    } catch {
      // Goal synthesis is best-effort — if the goal store is briefly
      // unavailable, the job still runs goal-less and renders without
      // a topic pill. Better than blocking the submit.
    }
  }

  const maxIterations = clampIterations(body.maxIterations);
  const id = randomUUID();
  const now = Date.now();
  const queue = labsQueue();

  const initial: LabsJob = {
    id,
    prompt,
    maxIterations,
    iterations: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    events: [],
    submitterTag: submitter,
    submitterWallet,
    goalId,
    moderation: 'visible',
  };

  const queued = appendJobEvent(initial, {
    kind: 'queued',
    message: `Submitted with ${maxIterations} iteration cap`,
  });

  try {
    await queue.enqueue(queued);
  } catch (err) {
    return json(
      {
        error: 'Failed to enqueue job — queue backend unavailable.',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503, headers: limit.headers },
    );
  }

  if (goalId) {
    await attachJobToGoal(goalId, id, now).catch(() => undefined);
  }

  const pending = await queue.pendingCount().catch(() => 0);

  return json(
    {
      id,
      status: 'pending' as const,
      queuedAhead: Math.max(0, pending - 1),
      createdAt: now,
    },
    { status: 202, headers: limit.headers },
  );
}

export async function GET(_req: NextRequest): Promise<Response> {
  const queue = labsQueue();
  const [entries, pending] = await Promise.all([
    queue.recent(20).catch(() => []),
    queue.pendingCount().catch(() => 0),
  ]);

  // Enrich entries with goal titles so the feed can group by topic.
  // Batch the goal lookups so we never refetch the same goal twice in
  // a single render.
  const goalIds = new Set<string>();
  for (const entry of entries) {
    if (entry.goalId) goalIds.add(entry.goalId);
  }
  const goals = new Map<
    string,
    { title: string; origin?: 'user' | 'branch'; parentGoalId?: string }
  >();
  await Promise.all(
    Array.from(goalIds).map(async (id) => {
      const goal = await getGoal(id).catch(() => null);
      if (goal) {
        goals.set(id, {
          title: goal.title,
          origin: goal.origin,
          parentGoalId: goal.parentGoalId,
        });
      }
    }),
  );

  // Walk up the ancestor chain to find the ROOT goal (user-submitted)
  // for each goal. We fetch ancestors iteratively until we hit a goal
  // with no parentGoalId (max 10 levels to prevent infinite loops).
  const MAX_DEPTH = 10;
  let fetchMore = true;
  for (let depth = 0; depth < MAX_DEPTH && fetchMore; depth++) {
    const missing = new Set<string>();
    for (const g of goals.values()) {
      if (g.parentGoalId && !goals.has(g.parentGoalId)) missing.add(g.parentGoalId);
    }
    if (missing.size === 0) {
      fetchMore = false;
      break;
    }
    await Promise.all(
      Array.from(missing).map(async (id) => {
        const goal = await getGoal(id).catch(() => null);
        if (goal) {
          goals.set(id, {
            title: goal.title,
            origin: goal.origin,
            parentGoalId: goal.parentGoalId,
          });
        }
      }),
    );
  }

  // Resolve the root ancestor for a given goal id.
  function findRoot(id: string): { id: string; title: string } | undefined {
    const visited = new Set<string>();
    let cur = id;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const g = goals.get(cur);
      if (!g) break;
      if (!g.parentGoalId || !goals.has(g.parentGoalId)) {
        return { id: cur, title: g.title };
      }
      cur = g.parentGoalId;
    }
    return undefined;
  }

  const enriched = entries.map((entry) => {
    if (!entry.goalId) return entry;
    const goal = goals.get(entry.goalId);
    if (!goal) return entry;
    const parent = goal.parentGoalId ? goals.get(goal.parentGoalId) : undefined;
    const root = findRoot(entry.goalId);
    return {
      ...entry,
      goalTitle: goal.title,
      goalOrigin: goal.origin,
      parentGoalId: goal.parentGoalId,
      parentGoalTitle: parent?.title,
      rootGoalId: root?.id,
      rootGoalTitle: root?.title,
    };
  });

  return json({ entries: enriched, pending });
}
