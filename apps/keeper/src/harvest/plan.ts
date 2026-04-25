/**
 * Pure, deterministic planner for the harvest run.
 *
 * Given a snapshot of on-chain state — treasury LP balances, pool
 * reserves, pool totalSupply, config — produces a fully-resolved plan of
 * the transactions that should be submitted. The planner does not touch
 * the network or send txs; that's the runner's job.
 *
 * Separating the two lets us unit-test the math (fee splitting, POL
 * weighting, slippage bounds, LP→underlying estimates, etc.) without
 * needing a fork or RPC.
 */

import type { Address } from 'viem';
import type { HarvestConfig } from './config.js';
import { DEAD_ADDRESS } from './config.js';

/**
 * A snapshot of a UniswapV2-style pair plus the treasury's position in it.
 * All amounts are raw token base units (wei-scale).
 */
export interface PairSnapshot {
  /** Pool identifier (for logging). */
  label: string;
  /** Pair contract. */
  pair: Address;
  /** Whichever underlying token is NOT ETX (ETI or WEGAZ in our universe). */
  nonEtx: Address;
  /** Pool reserves, canonicalized so .etx matches `etx` and .nonEtx matches `nonEtx`. */
  reserveEtx: bigint;
  reserveNonEtx: bigint;
  /** Total LP supply of the pair. */
  totalSupply: bigint;
  /** Treasury's LP balance on this pair. */
  treasuryLp: bigint;
}

/** A single tx the runner should submit, in order. */
export type HarvestAction =
  | {
      kind: 'approve-lp';
      pair: Address;
      spender: Address;
      amount: bigint;
      label: string;
    }
  | {
      kind: 'remove-liquidity';
      pair: Address;
      nonEtx: Address;
      lpToBurn: bigint;
      minEtxOut: bigint;
      minNonEtxOut: bigint;
      label: string;
    }
  | {
      kind: 'approve-erc20';
      token: Address;
      spender: Address;
      amount: bigint;
      label: string;
    }
  | {
      kind: 'swap-to-etx';
      nonEtx: Address;
      amountIn: bigint;
      minEtxOut: bigint;
      label: string;
    }
  | {
      kind: 'swap-from-etx';
      nonEtx: Address;
      etxIn: bigint;
      minNonEtxOut: bigint;
      label: string;
    }
  | {
      kind: 'add-liquidity-burn-lp';
      pair: Address;
      nonEtx: Address;
      etxAmount: bigint;
      nonEtxAmount: bigint;
      minEtxIn: bigint;
      minNonEtxIn: bigint;
      lpRecipient: Address; // always DEAD_ADDRESS
      label: string;
    }
  | {
      kind: 'distribute-to-staked-etx';
      vault: Address;
      amount: bigint;
    }
  | {
      kind: 'distribute-to-farms';
      farms: Address;
      amount: bigint;
    }
  | {
      kind: 'retain-in-treasury';
      treasury: Address;
      amount: bigint;
    };

export interface HarvestPlan {
  /** Empty when the run is a no-op (no treasury LP to harvest, etc.). */
  actions: HarvestAction[];
  /**
   * Per-pool breakdown for human-readable logging. Amounts are "expected"
   * values assuming the router returns the spot quote; real amounts may
   * differ by up to `maxSlippageBps`.
   */
  pools: Array<{
    label: string;
    pair: Address;
    lpToBurn: bigint;
    expectedEtxFromBurn: bigint;
    expectedNonEtxFromBurn: bigint;
    expectedEtxFromSwap: bigint;
  }>;
  /** Total ETX expected in treasury after all burns+swaps but before splits. */
  expectedEtxHarvested: bigint;
  /** Slice breakdown. */
  splits: {
    stakedEtx: bigint;
    farms: bigint;
    polBurn: bigint;
    treasury: bigint;
  };
  /** Per-pool POL burn amounts (ETX that will be paired + burned as LP). */
  polBurnByPool: Array<{ pair: Address; etxForPool: bigint; label: string }>;
  /** Reason the plan is empty, if it is. */
  skipReason?: string;
}

/** Apply slippage bps to a quoted amount: `quote * (10000 - bps) / 10000`. */
function withSlippage(quote: bigint, bps: number): bigint {
  if (bps <= 0) return quote;
  return (quote * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * Estimate how much of each underlying a burn of `lp` LP tokens yields.
 * Matches UniswapV2 `Pair.burn`: `amountX = liquidity * reserveX / totalSupply`.
 */
export function estimateBurnOut(
  lp: bigint,
  snapshot: PairSnapshot,
): { etxOut: bigint; nonEtxOut: bigint } {
  if (snapshot.totalSupply === 0n || lp === 0n) {
    return { etxOut: 0n, nonEtxOut: 0n };
  }
  const etxOut = (lp * snapshot.reserveEtx) / snapshot.totalSupply;
  const nonEtxOut = (lp * snapshot.reserveNonEtx) / snapshot.totalSupply;
  return { etxOut, nonEtxOut };
}

/**
 * Estimate swap output using the UniswapV2 constant-product formula with
 * a 0.30% fee: `out = reserveOut * amountIn * 997 / (reserveIn * 1000 + amountIn * 997)`.
 */
export function estimateSwapOut(
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

/**
 * Build the harvest plan.
 *
 * If `config.stakedEtx` / `config.farms` is null, the corresponding slice
 * is re-routed to the treasury via a `retain-in-treasury` action (still
 * logged as a separate line for transparency).
 */
export function buildHarvestPlan(
  config: HarvestConfig,
  pairs: PairSnapshot[],
): HarvestPlan {
  const pools: HarvestPlan['pools'] = [];
  const actions: HarvestAction[] = [];
  let expectedEtxHarvested = 0n;

  // 1. For each pool: compute the LP slice to burn, estimate underlying
  //    out, estimate swap-to-ETX for the non-ETX leg. Accumulate expected
  //    ETX harvested.
  for (const snap of pairs) {
    if (snap.treasuryLp === 0n) {
      pools.push({
        label: snap.label,
        pair: snap.pair,
        lpToBurn: 0n,
        expectedEtxFromBurn: 0n,
        expectedNonEtxFromBurn: 0n,
        expectedEtxFromSwap: 0n,
      });
      continue;
    }
    const lpToBurn = (snap.treasuryLp * BigInt(config.burnBpsPerRun)) / 10_000n;
    if (lpToBurn === 0n) {
      pools.push({
        label: snap.label,
        pair: snap.pair,
        lpToBurn: 0n,
        expectedEtxFromBurn: 0n,
        expectedNonEtxFromBurn: 0n,
        expectedEtxFromSwap: 0n,
      });
      continue;
    }
    const { etxOut, nonEtxOut } = estimateBurnOut(lpToBurn, snap);

    // Post-burn reserves for the in-situ swap estimate.
    const resEtxAfterBurn = snap.reserveEtx - etxOut;
    const resNonEtxAfterBurn = snap.reserveNonEtx - nonEtxOut;
    const etxFromSwap = estimateSwapOut(nonEtxOut, resNonEtxAfterBurn, resEtxAfterBurn);

    pools.push({
      label: snap.label,
      pair: snap.pair,
      lpToBurn,
      expectedEtxFromBurn: etxOut,
      expectedNonEtxFromBurn: nonEtxOut,
      expectedEtxFromSwap: etxFromSwap,
    });

    expectedEtxHarvested += etxOut + etxFromSwap;

    // Actions: approve LP to router, removeLiquidity, approve non-ETX to router, swap-to-ETX.
    actions.push({
      kind: 'approve-lp',
      pair: snap.pair,
      spender: config.router,
      amount: lpToBurn,
      label: snap.label,
    });
    actions.push({
      kind: 'remove-liquidity',
      pair: snap.pair,
      nonEtx: snap.nonEtx,
      lpToBurn,
      minEtxOut: withSlippage(etxOut, config.maxSlippageBps),
      minNonEtxOut: withSlippage(nonEtxOut, config.maxSlippageBps),
      label: snap.label,
    });
    if (nonEtxOut > 0n && etxFromSwap > 0n) {
      actions.push({
        kind: 'approve-erc20',
        token: snap.nonEtx,
        spender: config.router,
        amount: nonEtxOut,
        label: snap.label,
      });
      actions.push({
        kind: 'swap-to-etx',
        nonEtx: snap.nonEtx,
        amountIn: nonEtxOut,
        minEtxOut: withSlippage(etxFromSwap, config.maxSlippageBps),
        label: snap.label,
      });
    }
  }

  // 2. Compute split slices from expectedEtxHarvested. Use BPS math on
  //    the same basis so the four slices add up exactly to
  //    expectedEtxHarvested.
  const stakedEtxSlice = (expectedEtxHarvested * BigInt(config.split.stakedEtxBps)) / 10_000n;
  const farmsSlice = (expectedEtxHarvested * BigInt(config.split.farmsBps)) / 10_000n;
  const polSlice = (expectedEtxHarvested * BigInt(config.split.polBurnBps)) / 10_000n;
  // Dust from integer division lands in the treasury slice so the sum is exact.
  const treasurySlice = expectedEtxHarvested - stakedEtxSlice - farmsSlice - polSlice;

  const splits = {
    stakedEtx: stakedEtxSlice,
    farms: farmsSlice,
    polBurn: polSlice,
    treasury: treasurySlice,
  };

  if (expectedEtxHarvested === 0n) {
    return {
      actions: [],
      pools,
      expectedEtxHarvested: 0n,
      splits,
      polBurnByPool: [],
      skipReason: 'no treasury LP on either pool (or burn slice rounded to zero)',
    };
  }

  // 3. stETX slice: distributeRewards (or retain in treasury if not deployed).
  if (stakedEtxSlice > 0n) {
    if (config.stakedEtx === null) {
      actions.push({
        kind: 'retain-in-treasury',
        treasury: config.treasury,
        amount: stakedEtxSlice,
      });
    } else {
      actions.push({
        kind: 'approve-erc20',
        token: config.etx,
        spender: config.stakedEtx,
        amount: stakedEtxSlice,
        label: 'stETX',
      });
      actions.push({
        kind: 'distribute-to-staked-etx',
        vault: config.stakedEtx,
        amount: stakedEtxSlice,
      });
    }
  }

  // 4. Farms slice: distributeRewards (or retain if not deployed).
  if (farmsSlice > 0n) {
    if (config.farms === null) {
      actions.push({
        kind: 'retain-in-treasury',
        treasury: config.treasury,
        amount: farmsSlice,
      });
    } else {
      actions.push({
        kind: 'approve-erc20',
        token: config.etx,
        spender: config.farms,
        amount: farmsSlice,
        label: 'farms',
      });
      actions.push({
        kind: 'distribute-to-farms',
        farms: config.farms,
        amount: farmsSlice,
      });
    }
  }

  // 5. POL burn slice: split across pools by weighting, each pool's slice
  //    is split in half (ETX → non-ETX via swap, then pair + addLiquidity,
  //    LP to DEAD_ADDRESS).
  //
  //    The contract's `_distributePol` reverts with `PolAllocationInvalid`
  //    when the sum of per-pool POL assignments exceeds the on-chain
  //    polSlice (which is recomputed from the *actual* harvested ETX
  //    delta on the harvester's balance). Our off-chain `polSlice` is
  //    derived from the planner's `expectedEtxHarvested`, which is a
  //    spot estimate that can sit a few wei above the on-chain reality —
  //    most commonly because `_mintFee()` mints fresh LP to `feeTo`
  //    immediately before a burn, diluting the proportional return by a
  //    small amount we don't model off-chain. Distribute a slippage-
  //    buffered slice instead so we under-allocate by `maxSlippageBps`;
  //    the contract refunds any unassigned residual to the treasury.
  const polByPool: HarvestPlan['polBurnByPool'] = [];
  const polSliceForAllocation = withSlippage(polSlice, config.maxSlippageBps);
  if (polSliceForAllocation > 0n) {
    // Use ETX-denominated weight of each pool's treasury LP (reserveEtx
    // share controlled by the treasury). This captures "where the
    // treasury is already overweight" better than raw LP token counts,
    // which have different meanings per pool.
    const weights = pairs.map((snap) => {
      if (snap.totalSupply === 0n || snap.treasuryLp === 0n) return 0n;
      return (snap.reserveEtx * snap.treasuryLp) / snap.totalSupply;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0n);

    // Per-pool ETX allocation for the POL branch.
    const allocs: bigint[] = [];
    if (config.polWeighting === 'equal' || totalWeight === 0n) {
      const n = BigInt(pairs.length || 1);
      let acc = 0n;
      for (let i = 0; i < pairs.length; i++) {
        const share =
          i === pairs.length - 1 ? polSliceForAllocation - acc : polSliceForAllocation / n;
        allocs.push(share);
        acc += share;
      }
    } else {
      let acc = 0n;
      for (let i = 0; i < pairs.length; i++) {
        if (i === pairs.length - 1) {
          allocs.push(polSliceForAllocation - acc);
        } else {
          const share = (polSliceForAllocation * weights[i]!) / totalWeight;
          allocs.push(share);
          acc += share;
        }
      }
    }

    for (let i = 0; i < pairs.length; i++) {
      const snap = pairs[i]!;
      const etxForPool = allocs[i]!;
      polByPool.push({ pair: snap.pair, etxForPool, label: snap.label });
      if (etxForPool === 0n) continue;

      // Split the allocation: half buys non-ETX, half is paired with the
      // bought non-ETX. Use the post-burn reserves to estimate non-ETX
      // out, which is what the pool actually looks like at the time this
      // branch runs.
      const half = etxForPool / 2n;
      const etxForSwap = half;
      const etxForPair = etxForPool - half;
      if (etxForSwap === 0n || etxForPair === 0n) continue;

      // Reserves after the burn + swap-to-ETX steps have both run:
      //   removeLiquidity shrinks each side by (etxOut, nonEtxOut);
      //   swap-to-ETX sends nonEtxOut INTO the pool (reserve goes UP by
      //   nonEtxOut) and pulls etxFromSwap OUT (reserve goes DOWN).
      // Net deltas vs initial snapshot:
      //   reserveEtx'    = reserveEtx - etxOut - etxFromSwap
      //   reserveNonEtx' = reserveNonEtx - nonEtxOut + nonEtxOut = reserveNonEtx
      const pool = pools[i]!;
      const resEtx =
        snap.reserveEtx - pool.expectedEtxFromBurn - pool.expectedEtxFromSwap;
      const resNon = snap.reserveNonEtx;

      const nonEtxFromSwap = estimateSwapOut(etxForSwap, resEtx, resNon);
      if (nonEtxFromSwap === 0n) continue;

      // approve ETX → router, swap ETX → non-ETX, approve non-ETX → router,
      // addLiquidity with (etxForPair, nonEtxFromSwap), LP → DEAD_ADDRESS.
      actions.push({
        kind: 'approve-erc20',
        token: config.etx,
        spender: config.router,
        amount: etxForSwap,
        label: `${snap.label}/pol-swap`,
      });
      actions.push({
        kind: 'swap-from-etx',
        nonEtx: snap.nonEtx,
        etxIn: etxForSwap,
        minNonEtxOut: withSlippage(nonEtxFromSwap, config.maxSlippageBps),
        label: snap.label,
      });
      actions.push({
        kind: 'approve-erc20',
        token: config.etx,
        spender: config.router,
        amount: etxForPair,
        label: `${snap.label}/pol-pair-etx`,
      });
      actions.push({
        kind: 'approve-erc20',
        token: snap.nonEtx,
        spender: config.router,
        amount: nonEtxFromSwap,
        label: `${snap.label}/pol-pair-non`,
      });
      actions.push({
        kind: 'add-liquidity-burn-lp',
        pair: snap.pair,
        nonEtx: snap.nonEtx,
        etxAmount: etxForPair,
        nonEtxAmount: nonEtxFromSwap,
        minEtxIn: withSlippage(etxForPair, config.maxSlippageBps),
        minNonEtxIn: withSlippage(nonEtxFromSwap, config.maxSlippageBps),
        lpRecipient: DEAD_ADDRESS,
        label: snap.label,
      });
    }
  }

  // 6. Treasury retained slice is a no-op (ETX already lives in the
  //    treasury wallet), but we emit an action for log completeness.
  if (treasurySlice > 0n) {
    actions.push({
      kind: 'retain-in-treasury',
      treasury: config.treasury,
      amount: treasurySlice,
    });
  }

  return {
    actions,
    pools,
    expectedEtxHarvested,
    splits,
    polBurnByPool: polByPool,
  };
}
