/**
 * Builder that translates a {@link HarvestPlan} into the on-chain
 * `PoolPlan[]` calldata consumed by {@link TreasuryHarvester.harvest}.
 *
 * The multi-action `HarvestPlan` describes the pipeline as a sequence of
 * router calls for the treasury-signed legacy path. In delegation mode
 * the entire pipeline executes inside a single `harvest(pools)` call, so
 * the keeper just needs to surface per-pool parameters the contract
 * would otherwise recompute.
 *
 * This function is pure — no network, no signers. Easy to unit-test.
 */

import type { Address } from 'viem';
import type { HarvestConfig } from './config.js';
import type { HarvestPlan, PairSnapshot } from './plan.js';

/** Matches the calldata tuple of {@link TreasuryHarvester.PoolPlan}. */
export interface DelegationPoolPlan {
  pair: Address;
  nonEtx: Address;
  lpToBurn: bigint;
  minEtxFromBurn: bigint;
  minNonEtxFromBurn: bigint;
  minEtxFromSwap: bigint;
  polEtxForSwap: bigint;
  polEtxForPair: bigint;
  minNonEtxFromPolSwap: bigint;
}

export interface DelegationCall {
  /** The calldata array passed to `harvester.harvest(pools)`. */
  pools: DelegationPoolPlan[];
  /**
   * Sum of POL ETX assigned across pools. Must be <= plan.splits.polBurn
   * or the contract reverts with `PolAllocationInvalid`. Exposed for
   * logging + sanity checks.
   */
  totalPolAssigned: bigint;
}

function withSlippage(quote: bigint, bps: number): bigint {
  if (bps <= 0 || quote === 0n) return quote;
  return (quote * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * Build the delegation call. Per pool:
 *   - LP burn + non-ETX→ETX swap parameters come directly from the
 *     snapshot + plan (same estimates the treasury-signed path uses).
 *   - POL ETX split: the contract handles `totalPolAssigned <= polSlice`
 *     and refunds any residual to the treasury, so we can safely reuse
 *     the same per-pool POL amounts the planner derived.
 */
export function buildDelegationCall(
  config: HarvestConfig,
  pairs: PairSnapshot[],
  plan: HarvestPlan,
): DelegationCall {
  const pools: DelegationPoolPlan[] = [];
  let totalPolAssigned = 0n;

  for (let i = 0; i < pairs.length; i++) {
    const snap = pairs[i]!;
    const pool = plan.pools[i]!;
    const polForPool = plan.polBurnByPool[i]?.etxForPool ?? 0n;

    const polHalf = polForPool / 2n;
    const polEtxForSwap = polHalf;
    const polEtxForPair = polForPool - polHalf;

    // Non-ETX out from the POL swap, estimated against the same post-
    // burn/post-swap reserves the planner used (see plan.ts comment).
    // The contract also recomputes this on-chain, so the min guard only
    // needs to tolerate a slippage window around our off-chain estimate.
    const resEtxAfterHarvest =
      snap.reserveEtx - pool.expectedEtxFromBurn - pool.expectedEtxFromSwap;
    const resNonAfterHarvest = snap.reserveNonEtx;
    const nonEtxFromPolSwap = estimateSwapOut(
      polEtxForSwap,
      resEtxAfterHarvest,
      resNonAfterHarvest,
    );

    const entry: DelegationPoolPlan = {
      pair: snap.pair,
      nonEtx: snap.nonEtx,
      lpToBurn: pool.lpToBurn,
      minEtxFromBurn: withSlippage(pool.expectedEtxFromBurn, config.maxSlippageBps),
      minNonEtxFromBurn: withSlippage(pool.expectedNonEtxFromBurn, config.maxSlippageBps),
      minEtxFromSwap: withSlippage(pool.expectedEtxFromSwap, config.maxSlippageBps),
      polEtxForSwap,
      polEtxForPair,
      minNonEtxFromPolSwap: withSlippage(nonEtxFromPolSwap, config.maxSlippageBps),
    };

    // If the POL allocation rounds to a single wei on one leg we skip it;
    // the contract requires polEtxForSwap and polEtxForPair to be both
    // zero or both non-zero (UnevenPolPair).
    if (entry.polEtxForSwap === 0n || entry.polEtxForPair === 0n) {
      entry.polEtxForSwap = 0n;
      entry.polEtxForPair = 0n;
      entry.minNonEtxFromPolSwap = 0n;
    }

    totalPolAssigned += entry.polEtxForSwap + entry.polEtxForPair;
    pools.push(entry);
  }

  return { pools, totalPolAssigned };
}

function estimateSwapOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}
