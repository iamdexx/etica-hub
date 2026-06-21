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
  type KeeperPlan,
  type Observation,
  type PayoutPlan,
  type PayoutSplit,
  type Registration,
  type TwinRecord,
} from './types.js';

export interface PlanParams {
  /** TRX (SUN) to front into each new twin (0 = don't auto-front). */
  initialFrontSun: bigint;
  /** Minimum settled TRX (SUN) before a twin is worth paying out. */
  minPayoutSun: bigint;
  /** Reserve top-up share in basis points (100 = 1%). */
  reserveTopUpBps: number;
  /** Keeper ops share in basis points (100 = 1%). */
  keeperOpsBps: number;
}

/**
 * Three-way split: reserve top-up, keeper ops retention, and holder payout.
 * Reserve and keeper slices use floor division; the holder gets whatever is
 * left, so the three legs always sum back to exactly `amountSun` (no dust lost).
 */
export function splitPayout(
  amountSun: bigint,
  reserveTopUpBps: number,
  keeperOpsBps: number = 0,
): PayoutSplit {
  if (amountSun < 0n) throw new Error('amountSun must be non-negative');
  if (reserveTopUpBps < 0 || reserveTopUpBps > 10_000) {
    throw new Error('reserveTopUpBps out of range [0, 10000]');
  }
  if (keeperOpsBps < 0 || keeperOpsBps > 10_000) {
    throw new Error('keeperOpsBps out of range [0, 10000]');
  }
  if (reserveTopUpBps + keeperOpsBps > 10_000) {
    throw new Error('reserveTopUpBps + keeperOpsBps exceed 10000');
  }
  const reserveTopUpSun = (amountSun * BigInt(reserveTopUpBps)) / BPS_DENOMINATOR;
  const keeperOpsSun = (amountSun * BigInt(keeperOpsBps)) / BPS_DENOMINATOR;
  return { reserveTopUpSun, keeperOpsSun, payoutSun: amountSun - reserveTopUpSun - keeperOpsSun };
}

/**
 * Registrations that have no TRON twin yet. A twin is considered to exist if
 * its `resTokenId` appears in `mintedByResTokenId` (built from TwinMinted
 * events), which makes entry planning idempotent across ticks without local
 * state.
 */
export function planEntries(
  registrations: Registration[],
  mintedByResTokenId: Map<string, bigint>,
  initialFrontSun: bigint,
): EntryPlan[] {
  const out: EntryPlan[] = [];
  for (const reg of registrations) {
    if (mintedByResTokenId.has(reg.resTokenId.toString())) continue;
    out.push({
      resTokenId: reg.resTokenId,
      tronRecipient: reg.tronRecipient,
      payoutWallet: reg.payoutWallet,
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
  keeperOpsBps: number = 0,
): PayoutPlan[] {
  const out: PayoutPlan[] = [];
  for (const twin of twins) {
    if (twin.pendingSun < minPayoutSun || twin.pendingSun === 0n) continue;
    out.push({
      tokenId: twin.tokenId,
      payoutWallet: twin.payoutWallet,
      claimableSun: twin.pendingSun,
      split: splitPayout(twin.pendingSun, reserveTopUpBps, keeperOpsBps),
    });
  }
  return out;
}

/** Combine the two planners into a single tick plan. */
export function buildPlan(observation: Observation, params: PlanParams): KeeperPlan {
  return {
    entries: planEntries(observation.registrations, observation.mintedByResTokenId, params.initialFrontSun),
    payouts: planPayouts(observation.twins, params.minPayoutSun, params.reserveTopUpBps, params.keeperOpsBps),
  };
}

/** True when a plan has no actions — lets the loop stay quiet on idle ticks. */
export function isEmptyPlan(plan: KeeperPlan): boolean {
  return plan.entries.length === 0 && plan.payouts.length === 0;
}
