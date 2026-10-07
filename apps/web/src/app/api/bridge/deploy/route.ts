/**
 * Dispatches the mainnet bridge deploy after the keeper wallet has signed a
 * `BridgeDeploy` EIP-712 message in the browser (see /deploy/bridge).
 *
 * Checks, in order: body shape + role rules, deadline window, signature
 * recovers to BRIDGE_ROLES.keeper, nonce not already spent, then a single
 * `workflow_dispatch` of bridge-deploy.yml. `confirm` is forwarded as-is:
 * '' makes the workflow pre-flight only; DEPLOY-MAINNET broadcasts.
 */
import type { NextRequest } from 'next/server';
import type { Hex } from 'viem';
import {
  burnDeploySignature,
  deployNonceStore,
  dispatchBridgeDeploy,
  verifyDeployAuthorization,
} from '@/lib/bridge-deploy/server';
import { DEPLOY_CONFIRM_PHRASE, parseDeployMessage } from '@/lib/bridge-deploy/typed-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  const { message: rawMessage, signature } = (body ?? {}) as { message?: unknown; signature?: unknown };
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return json({ ok: false, error: 'signature must be a 65-byte hex string' }, { status: 400 });
  }

  const parsed = parseDeployMessage(rawMessage);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, { status: 400 });
  const message = parsed.message;

  const verified = await verifyDeployAuthorization(message, signature as Hex);
  if (!verified.ok) return json({ ok: false, error: verified.error }, { status: 401 });

  const store = deployNonceStore();
  if (!store) {
    return json(
      { ok: false, error: 'No nonce store (REDIS_URL / KV) configured; refusing to dispatch without replay protection.' },
      { status: 503 },
    );
  }
  let fresh: boolean;
  try {
    fresh = await burnDeploySignature(store, signature as Hex);
  } catch (err) {
    return json(
      { ok: false, error: `nonce store unavailable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 },
    );
  }
  if (!fresh) return json({ ok: false, error: 'this authorisation was already used' }, { status: 409 });

  const dispatched = await dispatchBridgeDeploy(message);
  if (!dispatched.ok) {
    return json(
      { ok: false, error: `github dispatch failed (${dispatched.status})`, detail: dispatched.detail },
      { status: 502 },
    );
  }
  return json({
    ok: true,
    dispatched: true,
    mode: message.confirm === DEPLOY_CONFIRM_PHRASE ? 'deploy' : 'preflight',
    step: message.step,
  });
}
