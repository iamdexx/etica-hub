/**
 * Operator final-veto endpoint.
 *
 * POST /api/labs/admin/moderation
 *   body: {
 *     action: 'hide' | 'approve' | 'restore',
 *     targetType: 'job' | 'goal',
 *     targetId: string,
 *     wallet: '0x…',              // must equal TREASURY_ADDRESS
 *     signature: '0x…',
 *     issuedAt: number,
 *     reason?: string
 *   }
 *
 * Authority hierarchy (highest wins):
 *   1. Layer-1 denylist        — terminal, even operator can't unblock
 *   2. Operator override       — sticky in either direction
 *   3. Community auto-thresholds
 *
 * Operator wallet is pinned to TREASURY_ADDRESS (or LABS_OPERATOR_ADDRESS
 * env override) and verified via the same EIP-191 envelope as community
 * votes.
 */
import { NextRequest } from 'next/server';
import { getAddress, isAddress, type Address } from 'viem';

import { TREASURY_ADDRESS } from '@etica-hub/shared';
import { verifyEticaMessage } from '@/lib/labs/sig-verify';

import { updateGoal } from '@/lib/labs/goal-store';
import {
  applyOperatorOverride,
  voteMessage,
  type ModTarget,
  type OperatorAction,
} from '@/lib/labs/moderation-store';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const MAX_SIG_AGE_MS = 10 * 60 * 1000;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function operatorAddress(): Address {
  const env = process.env.LABS_OPERATOR_ADDRESS?.trim();
  if (env && isAddress(env)) return getAddress(env);
  return getAddress(TREASURY_ADDRESS);
}

function isOperatorAction(v: unknown): v is OperatorAction {
  return v === 'hide' || v === 'approve' || v === 'restore';
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
  if (!isOperatorAction(action)) {
    return json(
      { error: 'action must be hide, approve, or restore.' },
      { status: 400, headers: limit.headers },
    );
  }
  if (!isModTarget(body.targetType)) {
    return json({ error: 'targetType must be job or goal.' }, { status: 400, headers: limit.headers });
  }
  const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
  if (!targetId) {
    return json({ error: 'targetId is required.' }, { status: 400, headers: limit.headers });
  }

  const walletRaw = typeof body.wallet === 'string' ? body.wallet.trim() : '';
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const issuedAt = typeof body.issuedAt === 'number' ? body.issuedAt : Number(body.issuedAt);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;

  if (!isAddress(walletRaw)) {
    return json({ error: 'wallet must be a 0x address.' }, { status: 400, headers: limit.headers });
  }
  const wallet = getAddress(walletRaw);
  const operator = operatorAddress();
  if (wallet !== operator) {
    return json({ error: 'Not authorised.' }, { status: 403, headers: limit.headers });
  }
  if (!/^0x[a-fA-F0-9]+$/.test(signature)) {
    return json({ error: 'signature must be 0x-hex.' }, { status: 400, headers: limit.headers });
  }
  if (!Number.isFinite(issuedAt)) {
    return json({ error: 'issuedAt must be a millisecond timestamp.' }, { status: 400, headers: limit.headers });
  }
  const age = Date.now() - issuedAt;
  if (age < -60_000 || age > MAX_SIG_AGE_MS) {
    return json({ error: 'Signature expired. Please re-sign.' }, { status: 400, headers: limit.headers });
  }

  const envelope = voteMessage({
    action: `operator-${action}`,
    targetType: body.targetType,
    targetId,
    reason,
    issuedAt,
  });

  const verify = await verifyEticaMessage({
    message: envelope,
    signature,
    expected: wallet,
  });
  if (!verify.ok) {
    const recovered = verify.recoveredEip191 ?? verify.recoveredRawKeccak;
    if (recovered && recovered.toLowerCase() !== wallet.toLowerCase()) {
      return json(
        {
          error: `Signature recovered to ${recovered} but you are connected as ${wallet}. Switch accounts in your wallet to the connected address and retry.`,
        },
        { status: 401, headers: limit.headers },
      );
    }
    return json({ error: 'Invalid signature.' }, { status: 401, headers: limit.headers });
  }

  const next = await applyOperatorOverride(body.targetType, targetId, action, wallet, reason);

  if (body.targetType === 'goal') {
    await updateGoal(targetId, { moderation: next }).catch(() => undefined);
  }

  return json({ status: next }, { status: 200, headers: limit.headers });
}
