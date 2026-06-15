/**
 * Pure planning logic for the wRES keeper.
 *
 * These functions take a snapshot of cross-chain state (`Observation`) plus the
 * economic policy and decide *what* should happen this tick. They perform no
 * I/O, never sign anything, and are fully deterministic — which is what makes
 * the keeper's decision-making unit-testable without either chain.
 *
 * The executor turns the resulting `KeeperPlan` into ordered on-chain calls
 * (or, in dry-run, into log lines).
 */

import {
  BPS_DENOMINATOR,
  type EntryPlan,
  type ExitPlan,
  type KeeperPlan,
  type LockRecord,
  type Observation,
  type PayoutPlan,
  type PayoutSplit,
  type PendingUnlock,
  type TwinRecord,
} from './types.js';

export interface PlanParams {
  /** TRX (SUN) to front into each new twin (0 = don't auto-front). */
  initialFrontSun: bigint;
  /** Minimum settled TRX (SUN) before a twin is worth paying out. */
  minPayoutSun: bigint;
  /** Reserve top-up share in basis points (100 = 1%). */
  reserveTopUpBps: number;
}

/**
 * Split a claimed amount into the 1% reserve top-up and the 99% holder payout.
 * Uses floor division for the reserve slice and gives the remainder to the
 * holder, so the two legs always sum back to exactly `amountSun` (no dust lost).
 */
export function splitPayout(amountSun: bigint, reserveTopUpBps: number): PayoutSplit {
  if (amountSun < 0n) throw new Error('amountSun must be non-negative');
  if (reserveTopUpBps < 0 || reserveTopUpBps > 10_000) {
    throw new Error('reserveTopUpBps out of range [0, 10000]');
  }
  const reserveTopUpSun = (amountSun * BigInt(reserveTopUpBps)) / BPS_DENOMINATOR;
  return { reserveTopUpSun, payoutSun: amountSun - reserveTopUpSun };
}

/**
 * New locks that have no TRON twin yet. A twin is considered to exist if its
 * `resTokenId` appears in `mintedByResTokenId` (built from TwinMinted events),
 * which makes entry planning idempotent across ticks without local state.
 */
export function planEntries(
  locks: LockRecord[],
  mintedByResTokenId: Map<string, bigint>,
  initialFrontSun: bigint,
): EntryPlan[] {
  const out: EntryPlan[] = [];
  for (const lock of locks) {
    if (mintedByResTokenId.has(lock.resTokenId.toString())) continue;
    out.push({
      resTokenId: lock.resTokenId,
      tronRecipient: lock.tronRecipient,
      payoutWallet: lock.payoutWallet,
      initialFrontSun,
    });
  }
  return out;
}

/** Twins whose settled reward clears the dust threshold, with their split. */
export function planPayouts(
  twins: TwinRecord[],
  minPayoutSun: bigint,
  reserveTopUpBps: number,
): PayoutPlan[] {
  const out: PayoutPlan[] = [];
  for (const twin of twins) {
    if (twin.pendingSun < minPayoutSun || twin.pendingSun === 0n) continue;
    out.push({
      tokenId: twin.tokenId,
      payoutWallet: twin.payoutWallet,
      claimableSun: twin.pendingSun,
      split: splitPayout(twin.pendingSun, reserveTopUpBps),
    });
  }
  return out;
}

/**
 * Owner-initiated unlock requests that have matured past their challenge window
 * and have not been vetoed (a veto resets `unlockReadyAt` to 0). These are
 * finalized with the permissionless `executeUnlock`, returning the RES to its
 * locker. The keeper performs this purely as a liveness convenience — anyone
 * can call it — so it never gates or seizes anything.
 */
export function planExits(pendingUnlocks: PendingUnlock[], nowSec: bigint): ExitPlan[] {
  const out: ExitPlan[] = [];
  for (const u of pendingUnlocks) {
    if (!u.active) continue;
    if (u.unlockReadyAt === 0n) continue; // no request, or vetoed
    if (nowSec < u.unlockReadyAt) continue; // still inside the challenge window
    out.push({ resTokenId: u.resTokenId });
  }
  return out;
}

/** Combine the three planners into a single tick plan. */
export function buildPlan(observation: Observation, params: PlanParams): KeeperPlan {
  return {
    entries: planEntries(observation.locks, observation.mintedByResTokenId, params.initialFrontSun),
    payouts: planPayouts(observation.twins, params.minPayoutSun, params.reserveTopUpBps),
    exits: planExits(observation.pendingUnlocks, observation.nowSec),
  };
}

/** True when a plan has no actions — lets the loop stay quiet on idle ticks. */
export function isEmptyPlan(plan: KeeperPlan): boolean {
  return plan.entries.length === 0 && plan.payouts.length === 0 && plan.exits.length === 0;
}
