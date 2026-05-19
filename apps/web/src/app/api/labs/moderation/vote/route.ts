/**
 * Wallet-gated community moderation vote endpoint.
 *
 * POST /api/labs/moderation/vote
 *   body: {
 *     action: 'flag' | 'vouch',
 *     targetType: 'job' | 'goal',
 *     targetId: string,
 *     wallet: '0x…',
 *     signature: '0x…',          // EIP-191 personal_sign over voteMessage()
 *     issuedAt: number,           // ms epoch, ≤ 10 min old
 *     reason?: string,            // required when action='flag'
 *     detail?: string
 *   }
 *
 * Returns { status, tallies, weightApplied, newStatus? }.
 *
 * - Submission is open to anyone (see /api/labs/queue).
 * - Moderation requires a wallet on chain 61803 holding ≥ 100 stETX.
 * - Vote weight = stETX balance, soft-capped at 100k stETX per wallet.
 * - One vote per wallet per item; flipping flag↔vouch overwrites the
 *   prior vote — no stacking.
 */
import { NextRequest } from 'next/server';

import { updateGoal } from '@/lib/labs/goal-store';
import {
  applyVote,
  type ModTarget,
} from '@/lib/labs/moderation-store';
import { isValidFlagReason } from '@/lib/labs/moderation';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import { verifyVotePayload } from '@/lib/labs/wallet-vote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function isModTarget(v: unknown): v is ModTarget {
  return v === 'job' || v === 'goal';
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);
  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const action = body.action;
  if (action !== 'flag' && action !== 'vouch') {
    return json({ error: 'action must be flag or vouch.' }, { status: 400, headers: limit.headers });
  }
  if (!isModTarget(body.targetType)) {
    return json({ error: 'targetType must be job or goal.' }, { status: 400, headers: limit.headers });
  }
  const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
  if (!targetId) {
    return json({ error: 'targetId is required.' }, { status: 400, headers: limit.headers });
  }
  const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const issuedAt = typeof body.issuedAt === 'number' ? body.issuedAt : Number(body.issuedAt);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;
  const detail = typeof body.detail === 'string' ? body.detail.trim() : undefined;

  if (action === 'flag' && reason && !isValidFlagReason(reason)) {
    return json({ error: 'Invalid flag reason.' }, { status: 400, headers: limit.headers });
  }

  const verification = await verifyVotePayload({
    action,
    targetType: body.targetType,
    targetId,
    wallet,
    reason,
    signature,
    issuedAt,
  });
  if (!verification.ok) {
    return json({ error: verification.error }, { status: verification.status, headers: limit.headers });
  }

  let result;
  try {
    result = await applyVote({
      action,
      targetType: body.targetType,
      targetId,
      wallet: verification.wallet,
      balance: verification.balance,
      reason: action === 'flag' ? (reason as never) : undefined,
      detail,
      signature,
      issuedAt,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Failed to apply vote.' },
      { status: 400, headers: limit.headers },
    );
  }

  // Keep the LabsGoal.moderation snapshot in sync when the community
  // verdict flipped a goal's status.
  if (body.targetType === 'goal' && result.newStatus) {
    await updateGoal(targetId, { moderation: result.newStatus }).catch(() => undefined);
  }

  return json(
    {
      status: result.status,
      newStatus: result.newStatus,
      weightApplied: result.weightApplied.toString(),
      tallies: {
        flagWeight: result.tallies.flagWeight.toString(),
        vouchWeight: result.tallies.vouchWeight.toString(),
        flagVoters: result.tallies.flagVoters,
        vouchVoters: result.tallies.vouchVoters,
      },
    },
    { status: 200, headers: limit.headers },
  );
}
