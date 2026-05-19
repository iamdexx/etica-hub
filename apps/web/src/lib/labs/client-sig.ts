/**
 * Client-side helpers for wallet-sig-gated EticaLabs submissions and
 * moderation votes.
 *
 * These mirror the server-side canonical messages so a wallet can sign
 * locally and the server can verify with viem. All messages are EIP-191
 * `personal_sign`. No gas, no transaction.
 */
import type { WalletClient, Address } from 'viem';

/** 32-char rolling hash matching `apps/web/src/lib/labs/submit-auth.ts`. */
function hashPayload(payload: string): string {
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

function voteMessage(input: {
  action:
    | 'flag'
    | 'vouch'
    | 'operator-hide'
    | 'operator-approve'
    | 'operator-restore'
    | 'submit-goal'
    | 'submit-job';
  targetType: 'goal' | 'job';
  targetId: string;
  reason?: string;
  issuedAt: number;
}): string {
  const parts = [
    'EticaLabs Community Moderation',
    `action: ${input.action}`,
    `target: ${input.targetType}/${input.targetId}`,
    input.reason ? `reason: ${input.reason}` : 'reason: none',
    `issuedAt: ${input.issuedAt}`,
    'I confirm this action with my wallet on chain 61803.',
  ];
  return parts.join('\n');
}

export function buildSubmitMessage(input: {
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

export function buildVoteMessage(input: {
  action:
    | 'flag'
    | 'vouch'
    | 'operator-hide'
    | 'operator-approve'
    | 'operator-restore';
  targetType: 'goal' | 'job';
  targetId: string;
  reason?: string;
  issuedAt: number;
}): string {
  return voteMessage(input);
}

export interface SubmitSigInput {
  action: 'submit-goal' | 'submit-job';
  payload: string;
  wallet: Address;
  walletClient: WalletClient;
}

export interface SubmitSigResult {
  wallet: Address;
  signature: `0x${string}`;
  issuedAt: number;
}

/**
 * Prompts the wallet to sign a canonical submission message and returns
 * the signature + issuedAt so the caller can POST them to the server.
 */
export async function signSubmit(input: SubmitSigInput): Promise<SubmitSigResult> {
  const issuedAt = Date.now();
  const message = buildSubmitMessage({
    action: input.action,
    payload: input.payload,
    issuedAt,
  });
  const signature = await input.walletClient.signMessage({
    account: input.wallet,
    message,
  });
  return { wallet: input.wallet, signature, issuedAt };
}

export interface VoteSigInput {
  action:
    | 'flag'
    | 'vouch'
    | 'operator-hide'
    | 'operator-approve'
    | 'operator-restore';
  targetType: 'goal' | 'job';
  targetId: string;
  reason?: string;
  wallet: Address;
  walletClient: WalletClient;
}

export interface VoteSigResult {
  wallet: Address;
  signature: `0x${string}`;
  issuedAt: number;
}

export async function signVote(input: VoteSigInput): Promise<VoteSigResult> {
  const issuedAt = Date.now();
  const message = buildVoteMessage({
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    issuedAt,
  });
  const signature = await input.walletClient.signMessage({
    account: input.wallet,
    message,
  });
  return { wallet: input.wallet, signature, issuedAt };
}
