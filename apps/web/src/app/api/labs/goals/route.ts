/**
 * Labs Goals collection endpoint.
 *
 * GET  /api/labs/goals             — list visible goals (newest first).
 * POST /api/labs/goals             — create a new goal. Open to anyone
 *                                    (no wallet required). Goes through
 *                                    Layer 1 (hard denylist) + Layer 2
 *                                    (Groq biomedical gate) at submit.
 *
 * Submission is wallet-gated (EIP-191 signature) but does NOT require
 * any token balance. Only the moderation surface (flag/vouch) requires
 * a wallet holding ≥ 100 stETX.
 */
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

import { createGoal, listGoals, summariseGoal } from '@/lib/labs/goal-store';
import {
  MAX_GOAL_DESCRIPTION,
  MAX_GOAL_TITLE,
} from '@/lib/labs/goal';
import { runBiomedicalGate, runHardDenylist } from '@/lib/labs/moderation';
import { consumeLabsRateLimit, getClientIp } from '@/lib/labs/rate-limit';
import { verifySubmitPayload } from '@/lib/labs/submit-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function submitterTag(req: NextRequest): string {
  const ip = getClientIp(req);
  if (!ip || ip === 'unknown') return 'anon';
  return createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

export async function GET(): Promise<Response> {
  const goals = await listGoals(40).catch(() => []);
  const visible = goals.filter(
    (g) => g.moderation === 'visible' || g.moderation === 'operator-approved',
  );
  return json({ goals: visible.map(summariseGoal) });
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);
  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  let body: {
    title?: unknown;
    description?: unknown;
    wallet?: unknown;
    signature?: unknown;
    issuedAt?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!title) {
    return json({ error: 'Title is required.' }, { status: 400, headers: limit.headers });
  }
  if (title.length > MAX_GOAL_TITLE) {
    return json(
      { error: `Title must be ${MAX_GOAL_TITLE} characters or fewer.` },
      { status: 400, headers: limit.headers },
    );
  }
  if (description.length > MAX_GOAL_DESCRIPTION) {
    return json(
      { error: `Description must be ${MAX_GOAL_DESCRIPTION} characters or fewer.` },
      { status: 400, headers: limit.headers },
    );
  }

  const auth = await verifySubmitPayload({
    action: 'submit-goal',
    payload: title,
    wallet: typeof body.wallet === 'string' ? body.wallet : '',
    signature: typeof body.signature === 'string' ? body.signature : '',
    issuedAt: typeof body.issuedAt === 'number' ? body.issuedAt : 0,
  });
  if (!auth.ok) {
    return json({ error: auth.error }, { status: auth.status, headers: limit.headers });
  }

  const combined = `${title}\n${description}`;
  const deny = runHardDenylist(combined);
  if (!deny.ok) {
    return json(
      {
        error:
          'This goal is outside the scope of EticaLabs. Goals are limited to biomedical and life-sciences research.',
      },
      { status: 403, headers: limit.headers },
    );
  }

  const apiKey = process.env.GROQ_API_KEY ?? '';
  if (apiKey || process.env.GROQ_API_KEYS) {
    const gate = await runBiomedicalGate(combined, apiKey);
    if (gate.verdict !== 'yes') {
      return json(
        {
          error:
            gate.verdict === 'no'
              ? 'EticaLabs goals must be biomedical or life-sciences research objectives.'
              : 'Could not confirm this is a biomedical research goal. Please add more detail.',
        },
        { status: 403, headers: limit.headers },
      );
    }
  }

  const goal = await createGoal({
    title,
    description,
    submitterTag: submitterTag(req),
    submitterWallet: auth.wallet,
  });
  return json({ goal: summariseGoal(goal) }, { status: 201, headers: limit.headers });
}
