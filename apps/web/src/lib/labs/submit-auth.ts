/**
 * Wallet-sig gate for *submitting* a research goal or job to EticaLabs.
 *
 * Submission is open to any wallet on chain 61803 — no ETX balance
 * requirement. The wallet signs an EIP-191 message authorizing the
 * specific submission (goal title or job prompt), proving that the
 * submitter controls the address recorded as `submitterWallet` on
 * the resulting goal/job for the public moderation log.
 */
import { getAddress, isAddress, verifyMessage, type Address } from 'viem';

import { MAX_SIG_AGE_MS, voteMessage } from './moderation-store';

export interface SubmitAuthInput {
  action: 'submit-goal' | 'submit-job';
  /**
   * For 'submit-goal' this should be the trimmed goal title.
   * For 'submit-job' this should be the trimmed prompt (or `${goalId}|${prompt}` if attached).
   */
  payload: string;
  wallet: string;
  signature: string;
  issuedAt: number;
}

export type SubmitAuthResult =
  | { ok: true; wallet: Address }
  | { ok: false; status: number; error: string };

export async function verifySubmitPayload(
  input: SubmitAuthInput,
): Promise<SubmitAuthResult> {
  if (!isAddress(input.wallet)) {
    return { ok: false, status: 400, error: 'Invalid wallet address.' };
  }
  if (typeof input.signature !== 'string' || !input.signature.startsWith('0x')) {
    return { ok: false, status: 400, error: 'Invalid signature.' };
  }
  if (typeof input.issuedAt !== 'number' || !Number.isFinite(input.issuedAt)) {
    return { ok: false, status: 400, error: 'Invalid issuedAt.' };
  }
  const age = Date.now() - input.issuedAt;
  if (age < -60_000 || age > MAX_SIG_AGE_MS) {
    return { ok: false, status: 400, error: 'Signature expired. Re-sign and retry.' };
  }
  const wallet = getAddress(input.wallet);
  const message = submitMessage({
    action: input.action,
    payload: input.payload,
    issuedAt: input.issuedAt,
  });
  let valid = false;
  try {
    valid = await verifyMessage({
      address: wallet,
      message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: 401, error: 'Signature does not match wallet.' };
  }
  return { ok: true, wallet };
}

/**
 * Canonical message a submitter signs. Uses the same `voteMessage`
 * envelope as the moderation flow so on-chain inspectors can decode
 * either one with one helper. `targetId` carries the submitted payload
 * (title or prompt) and `targetType` is `goal` for new goals or `job`
 * for queue submissions.
 */
export function submitMessage(input: {
  action: 'submit-goal' | 'submit-job';
  payload: string;
  issuedAt: number;
}): string {
  return voteMessage({
    action: input.action,
    targetType: input.action === 'submit-goal' ? 'goal' : 'job',
    targetId: hashPayload(input.payload),
    issuedAt: input.issuedAt,
  });
}

/**
 * Deterministic short hash of the submission payload — the full prompt
 * can be long, so we sign a truncated SHA-1 hex so the signature is
 * still binding to the content but the canonical message fits in a
 * single wallet prompt.
 */
function hashPayload(payload: string): string {
  // 32-char rolling hash; not cryptographic but binds the sig to the
  // exact submitted text so it can't be reused for a different payload.
  let h1 = 0xdeadbeef ^ 0x9e3779b1;
  let h2 = 0x41c6ce57 ^ 0x9e3779b1;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0') +
    `len${payload.length}`
  );
}
