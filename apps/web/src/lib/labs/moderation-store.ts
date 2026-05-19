/**
 * Wallet-gated, stETX-weighted community moderation storage for EticaLabs.
 *
 * The moderation surface (flag/vouch) is restricted to connected wallets
 * on chain 61803 holding ≥ {@link MIN_VOTE_BALANCE_STETX} stETX. Vote
 * weight is the wallet's stETX balance at vote time, soft-capped at
 * {@link MAX_VOTE_WEIGHT_STETX} so a single whale cannot singlehandedly
 * hide or restore content.
 *
 * Moderation rights flow from active staking participation (depositing
 * ETX into the ERC-4626 vault), not from passive token holding — which
 * keeps the community-moderation gate squarely on the utility side of
 * any securities analysis.
 *
 * Auto-thresholds (community auto-actions only — operator-overridden
 * items are exempt):
 *   - hide: total flag-weight > total vouch-weight AND
 *           distinct flaggers ≥ {@link HIDE_MIN_VOTERS} AND
 *           flag-weight ≥ {@link HIDE_MIN_TOTAL_WEIGHT_STETX}
 *   - restore: vouch-weight - flag-weight ≥ {@link RESTORE_DELTA_STETX}
 *
 * Key layout:
 *   labs:mod:status:{type}:{id}        STRING    current ModerationStatus
 *   labs:mod:flags:{type}:{id}         ZSET      member=wallet, score=weight
 *   labs:mod:vouches:{type}:{id}       ZSET      member=wallet, score=weight
 *   labs:mod:meta:{type}:{id}:{wallet} STRING    JSON {reason, sig, at}
 *   labs:mod:log                       ZSET      member=eventJson, score=ts
 *
 * Signatures are EIP-191 (`personal_sign`) on the canonical message
 * returned by {@link voteMessage}. The signature is stored verbatim
 * for public-audit purposes; anyone can re-verify with viem.
 */
import { getAddress, isAddress, type Address } from 'viem';

import {
  COMMUNITY_HIDE_THRESHOLD,
  evaluateCommunityVerdict,
  isValidFlagReason,
  type FlagReason,
  type ModerationEvent,
  type ModerationStatus,
} from './moderation';
import { labsStore } from './store';

export const MIN_VOTE_BALANCE_STETX = 100n * 10n ** 18n;
export const MAX_VOTE_WEIGHT_STETX = 100_000n * 10n ** 18n;
export const HIDE_MIN_VOTERS = COMMUNITY_HIDE_THRESHOLD;
export const HIDE_MIN_TOTAL_WEIGHT_STETX = 1_000n * 10n ** 18n;
export const RESTORE_DELTA_STETX = 5_000n * 10n ** 18n;

export type ModTarget = 'job' | 'goal';

const STATUS_KEY = (t: ModTarget, id: string) => `labs:mod:status:${t}:${id}`;
const FLAGS_KEY = (t: ModTarget, id: string) => `labs:mod:flags:${t}:${id}`;
const VOUCHES_KEY = (t: ModTarget, id: string) => `labs:mod:vouches:${t}:${id}`;
const META_KEY = (t: ModTarget, id: string, wallet: string) =>
  `labs:mod:meta:${t}:${id}:${wallet.toLowerCase()}`;
const LOG_KEY = 'labs:mod:log';

/* ------------------------------------------------------------------ */
/*  Canonical vote message                                             */
/* ------------------------------------------------------------------ */

/**
 * Canonical EIP-191 message a voter signs to authorise a flag/vouch.
 * Embeds the action, target, reason, and a recent timestamp window
 * (rejected if older than {@link MAX_SIG_AGE_MS}).
 */
export function voteMessage(input: {
  action:
    | 'flag'
    | 'vouch'
    | 'operator-hide'
    | 'operator-approve'
    | 'operator-restore'
    | 'submit-goal'
    | 'submit-job';
  targetType: ModTarget;
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

export const MAX_SIG_AGE_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Status                                                             */
/* ------------------------------------------------------------------ */

export async function getStatus(t: ModTarget, id: string): Promise<ModerationStatus> {
  const store = labsStore();
  const raw = await store.get(STATUS_KEY(t, id));
  if (
    raw === 'visible' ||
    raw === 'hidden' ||
    raw === 'operator-hidden' ||
    raw === 'operator-approved' ||
    raw === 'denied'
  ) {
    return raw;
  }
  return 'visible';
}

export async function setStatus(t: ModTarget, id: string, status: ModerationStatus): Promise<void> {
  const store = labsStore();
  await store.set(STATUS_KEY(t, id), status);
}

/* ------------------------------------------------------------------ */
/*  Counts                                                             */
/* ------------------------------------------------------------------ */

export interface ModerationTallies {
  flagWeight: bigint;
  vouchWeight: bigint;
  flagVoters: number;
  vouchVoters: number;
  /** Set of wallet addresses currently casting a flag. */
  flagWallets: string[];
  /** Set of wallet addresses currently casting a vouch. */
  vouchWallets: string[];
}

async function readWeights(
  key: string,
): Promise<{ total: bigint; voters: number; wallets: string[] }> {
  const store = labsStore();
  const wallets = await store.zrevrange(key, 0, 999);
  if (!wallets.length) return { total: 0n, voters: 0, wallets: [] };
  let total = 0n;
  for (const w of wallets) {
    const meta = await store.get(`${key}:weight:${w.toLowerCase()}`);
    if (meta) {
      try {
        total += BigInt(meta);
      } catch {
        // ignore
      }
    }
  }
  return { total, voters: wallets.length, wallets };
}

export async function readTallies(t: ModTarget, id: string): Promise<ModerationTallies> {
  const flags = await readWeights(FLAGS_KEY(t, id));
  const vouches = await readWeights(VOUCHES_KEY(t, id));
  return {
    flagWeight: flags.total,
    vouchWeight: vouches.total,
    flagVoters: flags.voters,
    vouchVoters: vouches.voters,
    flagWallets: flags.wallets,
    vouchWallets: vouches.wallets,
  };
}

/* ------------------------------------------------------------------ */
/*  Vote application                                                   */
/* ------------------------------------------------------------------ */

export interface VoteInput {
  action: 'flag' | 'vouch';
  targetType: ModTarget;
  targetId: string;
  wallet: string;
  balance: bigint;
  reason?: FlagReason;
  detail?: string;
  signature: string;
  issuedAt: number;
}

export interface VoteResult {
  status: ModerationStatus;
  tallies: ModerationTallies;
  weightApplied: bigint;
  newStatus?: ModerationStatus;
}

/** Soft-cap stETX balance into a vote weight. */
export function weightFor(balance: bigint): bigint {
  if (balance <= 0n) return 0n;
  return balance > MAX_VOTE_WEIGHT_STETX ? MAX_VOTE_WEIGHT_STETX : balance;
}

async function recordVote(
  t: ModTarget,
  id: string,
  action: 'flag' | 'vouch',
  wallet: string,
  weight: bigint,
  meta: Pick<VoteInput, 'reason' | 'detail' | 'signature' | 'issuedAt'>,
): Promise<void> {
  const store = labsStore();
  const lowered = wallet.toLowerCase();
  const targetKey = action === 'flag' ? FLAGS_KEY(t, id) : VOUCHES_KEY(t, id);
  const otherKey = action === 'flag' ? VOUCHES_KEY(t, id) : FLAGS_KEY(t, id);
  // Remove any prior opposite vote from this wallet.
  await store.zrem(otherKey, lowered);
  await store.del(`${otherKey}:weight:${lowered}`);
  // Persist this vote.
  await store.zadd(targetKey, Number(weight / 10n ** 18n) || 1, lowered);
  await store.set(`${targetKey}:weight:${lowered}`, weight.toString());
  await store.set(
    META_KEY(t, id, lowered),
    JSON.stringify({
      action,
      reason: meta.reason ?? null,
      detail: meta.detail ?? null,
      signature: meta.signature,
      issuedAt: meta.issuedAt,
      weight: weight.toString(),
    }),
  );
}

async function appendLog(event: ModerationEvent): Promise<void> {
  const store = labsStore();
  await store.zadd(LOG_KEY, event.at, JSON.stringify(event));
}

export async function applyVote(input: VoteInput): Promise<VoteResult> {
  if (!isAddress(input.wallet)) throw new Error('invalid-wallet');
  const wallet = getAddress(input.wallet);
  const weight = weightFor(input.balance);
  if (weight <= 0n) throw new Error('zero-weight');
  if (input.action === 'flag' && input.reason && !isValidFlagReason(input.reason)) {
    throw new Error('invalid-reason');
  }

  const status = await getStatus(input.targetType, input.targetId);
  // Only the Layer-1 hard denylist is absolute. Operator overrides are
  // a reversible kill switch — sufficient community vouches can lift
  // an operator-hide, and sufficient community flags can override an
  // operator-approve. The operator's action still appears prominently
  // on the public moderation log either way.
  if (status === 'denied') {
    const tallies = await readTallies(input.targetType, input.targetId);
    return { status, tallies, weightApplied: 0n };
  }

  await recordVote(
    input.targetType,
    input.targetId,
    input.action,
    wallet,
    weight,
    {
      reason: input.reason,
      detail: input.detail,
      signature: input.signature,
      issuedAt: input.issuedAt,
    },
  );

  const tallies = await readTallies(input.targetType, input.targetId);
  let newStatus: ModerationStatus | undefined;
  const verdict = evaluateWeightedVerdict(status, tallies);
  if (verdict && verdict !== status) {
    await setStatus(input.targetType, input.targetId, verdict);
    newStatus = verdict;
    const overrodeOperator =
      status === 'operator-hidden' || status === 'operator-approved';
    let logKind: ModerationEvent['kind'];
    if (overrodeOperator) {
      logKind = 'community-overrode-operator';
    } else if (verdict === 'hidden') {
      logKind = 'community-hidden';
    } else {
      logKind = 'community-restored';
    }
    await appendLog({
      at: Date.now(),
      kind: logKind,
      targetType: input.targetType,
      targetId: input.targetId,
      actor: wallet,
      flagCount: tallies.flagVoters,
      vouchCount: tallies.vouchVoters,
      reason: overrodeOperator ? `was ${status}` : undefined,
    });
  }

  await appendLog({
    at: Date.now(),
    kind: input.action === 'flag' ? 'flag' : 'vouch',
    targetType: input.targetType,
    targetId: input.targetId,
    actor: wallet,
    reason: input.reason ?? input.detail,
    flagCount: tallies.flagVoters,
    vouchCount: tallies.vouchVoters,
  });

  return {
    status: newStatus ?? status,
    tallies,
    weightApplied: weight,
    newStatus,
  };
}

/**
 * stETX-weighted analogue of {@link evaluateCommunityVerdict}.
 */
export function evaluateWeightedVerdict(
  current: ModerationStatus,
  tallies: ModerationTallies,
): ModerationStatus | null {
  // Layer-1 hard denylist is the only absolute floor.
  if (current === 'denied') return null;

  // From any non-denied state, the community can force the item to
  // `visible` with a sufficient vouch-over-flag margin. This is what
  // makes operator-hide reversible.
  if (tallies.vouchWeight >= tallies.flagWeight + RESTORE_DELTA_STETX) {
    if (current !== 'visible') return 'visible';
  }

  // From any non-denied state, the community can force the item to
  // `hidden` with enough distinct flaggers and a sufficient weight
  // margin. This is what lets the community override operator-approve.
  if (
    tallies.flagVoters >= HIDE_MIN_VOTERS &&
    tallies.flagWeight > tallies.vouchWeight &&
    tallies.flagWeight >= HIDE_MIN_TOTAL_WEIGHT_STETX
  ) {
    if (current === 'visible' || current === 'operator-approved') {
      return 'hidden';
    }
  }

  // Touch the imported helper so a future per-vote helper can use it
  // and tree-shaking doesn't drop the module.
  void evaluateCommunityVerdict;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Operator final-veto                                                */
/* ------------------------------------------------------------------ */

export type OperatorAction = 'hide' | 'approve' | 'restore';

export async function applyOperatorOverride(
  t: ModTarget,
  id: string,
  action: OperatorAction,
  operator: Address,
  reason?: string,
): Promise<ModerationStatus> {
  const status = await getStatus(t, id);
  if (status === 'denied') {
    // Layer-1 floor is unrevertable, even by operator.
    return status;
  }
  let next: ModerationStatus;
  let kind: ModerationEvent['kind'];
  if (action === 'hide') {
    next = 'operator-hidden';
    kind = 'operator-hidden';
  } else if (action === 'approve') {
    next = 'operator-approved';
    kind = 'operator-approved';
  } else {
    next = 'visible';
    kind = 'operator-restored';
  }
  await setStatus(t, id, next);
  await appendLog({
    at: Date.now(),
    kind,
    targetType: t,
    targetId: id,
    actor: operator,
    reason,
  });
  return next;
}

/* ------------------------------------------------------------------ */
/*  Layer-1 denylist (terminal)                                        */
/* ------------------------------------------------------------------ */

export async function applyDenylistRejection(
  t: ModTarget,
  id: string,
  category: string,
): Promise<void> {
  await setStatus(t, id, 'denied');
  await appendLog({
    at: Date.now(),
    kind: 'denied',
    targetType: t,
    targetId: id,
    actor: 'system',
    reason: category,
  });
}

/* ------------------------------------------------------------------ */
/*  Audit log                                                          */
/* ------------------------------------------------------------------ */

export async function recentModerationLog(limit = 100): Promise<ModerationEvent[]> {
  const store = labsStore();
  const rows = await store.zrevrange(LOG_KEY, 0, Math.max(0, limit - 1));
  const out: ModerationEvent[] = [];
  for (const raw of rows) {
    try {
      const parsed = JSON.parse(raw) as ModerationEvent;
      if (parsed && typeof parsed.at === 'number') out.push(parsed);
    } catch {
      // skip malformed entries
    }
  }
  return out;
}
