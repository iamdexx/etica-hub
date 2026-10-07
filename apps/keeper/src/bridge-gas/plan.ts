/**
 * Pure planning for one bridge-gas leg. No I/O: the runner snapshots chain
 * state and quotes, this decides what to do.
 *
 * Per run, in order:
 *   1. claim   — sweep the fee contract into the keeper wallet once it holds
 *                at least `minStable` (amortises Ethereum gas)
 *   2. swap    — if native gas is under `minNative`, swap just enough stable
 *                for wrapped native (bounded by price impact + slippage)
 *   3. surplus — everything left above `reserveStable` leaves the wallet for
 *                good: on Etica it is paired into the USDC.e/ETX pool and the
 *                LP is burned (protocol-owned liquidity, like the pool fees);
 *                on Ethereum it is bridged to the keeper's Etica wallet so the
 *                next run burns it there. Nothing ever goes to a wallet.
 */

import { estimateSwapOut } from '../harvest/plan.js';

export interface LegSnapshot {
  /** Keeper's native balance (wei). */
  nativeBalance: bigint;
  /** Stable sitting in the fee contract, claimable by the keeper. */
  feeContractBalance: bigint;
  /** Stable already in the keeper wallet. */
  walletStable: bigint;
  /** Whether the keeper is the fee contract's owner (can `claim`). */
  keeperOwnsFeeContract: boolean;
}

export interface LegThresholds {
  minNative: bigint;
  targetNative: bigint;
  /** Don't claim / swap amounts below this (stable units). */
  minStable: bigint;
  maxSlippageBps: number;
  /** Stable kept in the wallet for future top-ups; only the excess leaves. */
  reserveStable: bigint;
  /** Only burn / bridge the surplus when it is at least this. */
  minSweep: bigint;
}

export interface SwapQuote {
  /** Stable needed for `nativeNeeded`, from router.getAmountsIn. */
  amountIn: bigint;
  /** Wrapped native obtained for `amountIn`, from router.getAmountsOut. */
  amountOut: bigint;
  /** Wrapped native obtained for one `probe` of stable (marginal price). */
  probeIn: bigint;
  probeOut: bigint;
}

export interface SwapPlan {
  amountIn: bigint;
  minOut: bigint;
  nativeNeeded: bigint;
}

export interface LegDecision {
  /** Stable to pull from the fee contract this run (0 = skip). */
  claim: bigint;
  /** Stable -> native swap, or null when gas is healthy / swap not possible. */
  swap: SwapPlan | null;
  /** Stable leaving the wallet after claim + swap: POL burn on Etica, bridged on Ethereum (0 = skip). */
  surplus: bigint;
  /** Why no swap was planned although gas is low (null otherwise). */
  blocked: string | null;
  reason: string;
}

/** Reserves of the USDC.e/ETX pool, oriented by token. */
export interface PolReserves {
  stable: bigint;
  etx: bigint;
}

/**
 * One POL burn: half the surplus buys ETX, the other half is paired with
 * that ETX and the LP tokens go to the dead address. Mirrors the
 * harvester's `add-liquidity-burn-lp` branch.
 */
export interface PolBurnPlan {
  stableForSwap: bigint;
  minEtxOut: bigint;
  /** ETX expected from the swap at current reserves (desired amount for addLiquidity). */
  expectedEtxOut: bigint;
  stableForPair: bigint;
  minStableIn: bigint;
  minEtxIn: bigint;
}

const BPS = 10_000n;

export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * (BPS - BigInt(bps))) / BPS;
}

/** How much stable the keeper should sweep from the fee contract this run. */
export function claimAmount(snap: LegSnapshot, t: LegThresholds): bigint {
  if (!snap.keeperOwnsFeeContract) return 0n;
  return snap.feeContractBalance >= t.minStable ? snap.feeContractBalance : 0n;
}

/** Native shortfall to reach the target; 0 when the balance is healthy. */
export function nativeNeeded(snap: LegSnapshot, t: LegThresholds): bigint {
  if (snap.nativeBalance >= t.minNative) return 0n;
  return t.targetNative - snap.nativeBalance;
}

/**
 * Price impact of the planned swap against the marginal price, in BPS.
 * Positive = worse than marginal. Guards against a thin pool eating the
 * whole fee balance for a trickle of gas.
 */
export function priceImpactBps(q: SwapQuote): bigint {
  if (q.probeIn === 0n || q.probeOut === 0n || q.amountIn === 0n) return 0n;
  // marginal: out per in at the probe size; realised: out per in at the swap size
  const expectedOut = (q.amountIn * q.probeOut) / q.probeIn;
  if (expectedOut === 0n) return 0n;
  if (q.amountOut >= expectedOut) return 0n;
  return ((expectedOut - q.amountOut) * BPS) / expectedOut;
}

/**
 * Surplus: whatever stable the wallet will hold after claim + swap, minus
 * the operating reserve. Never released while a needed swap is blocked —
 * the stable is held so a later run can still buy gas.
 */
export function surplusAmount(
  snap: LegSnapshot,
  t: LegThresholds,
  claim: bigint,
  swapIn: bigint,
  blocked: boolean,
): bigint {
  if (blocked) return 0n;
  const held = snap.walletStable + claim - swapIn;
  if (held <= t.reserveStable) return 0n;
  const excess = held - t.reserveStable;
  return excess >= t.minSweep ? excess : 0n;
}

/**
 * Split a surplus into swap + pair legs against the pool's current reserves.
 * Returns `blocked` (and no plan) when the pool is missing/too thin for the
 * swap half to clear within `maxSlippageBps` of the spot price — the stable
 * is then simply held until the pool is deeper or the surplus smaller.
 */
export function planPolBurn(
  surplus: bigint,
  reserves: PolReserves | null,
  maxSlippageBps: number,
): { plan: PolBurnPlan | null; blocked: string | null } {
  if (surplus <= 0n) return { plan: null, blocked: null };
  if (!reserves || reserves.stable === 0n || reserves.etx === 0n) {
    return { plan: null, blocked: 'no USDC.e/ETX pool liquidity' };
  }
  const stableForSwap = surplus / 2n;
  const stableForPair = surplus - stableForSwap;
  if (stableForSwap === 0n) return { plan: null, blocked: 'surplus too small to split' };

  const etxOut = estimateSwapOut(stableForSwap, reserves.stable, reserves.etx);
  const spotOut = (stableForSwap * reserves.etx) / reserves.stable;
  if (etxOut === 0n || spotOut === 0n) return { plan: null, blocked: 'swap too small to price' };
  const impact = ((spotOut - etxOut) * BPS) / spotOut;
  if (impact > BigInt(maxSlippageBps)) {
    return { plan: null, blocked: `POL swap price impact ${impact} bps exceeds ${maxSlippageBps} bps` };
  }

  // After the swap the pool holds (stable + stableForSwap, etx - etxOut); the
  // router pairs at that ratio, so the stable side we actually deposit is
  // min(stableForPair, etxOut * stable' / etx'). Both minimums get slippage.
  const stableAfter = reserves.stable + stableForSwap;
  const etxAfter = reserves.etx - etxOut;
  const stableMatched = (etxOut * stableAfter) / etxAfter;
  const stableIn = stableMatched < stableForPair ? stableMatched : stableForPair;
  const etxIn = (stableIn * etxAfter) / stableAfter;
  return {
    plan: {
      stableForSwap,
      minEtxOut: withSlippage(etxOut, maxSlippageBps),
      expectedEtxOut: etxOut,
      stableForPair,
      minStableIn: withSlippage(stableIn, maxSlippageBps),
      minEtxIn: withSlippage(etxIn, maxSlippageBps),
    },
    blocked: null,
  };
}

export function decideLeg(
  snap: LegSnapshot,
  t: LegThresholds,
  quote: SwapQuote | null,
): LegDecision {
  const claim = claimAmount(snap, t);
  const needed = nativeNeeded(snap, t);
  const available = snap.walletStable + claim;

  let swap: SwapPlan | null = null;
  let blocked: string | null = null;
  let reason = 'gas above minimum';

  if (needed > 0n) {
    if (available < t.minStable) {
      blocked = 'no stable to swap: fees have not accrued yet';
    } else if (!quote) {
      blocked = 'router returned no quote';
    } else {
      // Spend at most what we have; if that buys less than the full top-up we
      // still take it — some gas beats none.
      const amountIn = quote.amountIn > available ? available : quote.amountIn;
      const impact = priceImpactBps(quote);
      if (impact > BigInt(t.maxSlippageBps)) {
        blocked = `price impact ${impact} bps exceeds ${t.maxSlippageBps} bps`;
      } else {
        const expectedOut =
          amountIn === quote.amountIn ? quote.amountOut : (amountIn * quote.amountOut) / quote.amountIn;
        const minOut = (expectedOut * (BPS - BigInt(t.maxSlippageBps))) / BPS;
        if (minOut === 0n) blocked = 'swap too small to price';
        else swap = { amountIn, minOut, nativeNeeded: needed };
      }
    }
    reason = swap ? 'topping up gas' : `gas low, swap blocked: ${blocked}`;
  }

  const surplus = surplusAmount(snap, t, claim, swap?.amountIn ?? 0n, blocked !== null);
  return { claim, swap, surplus, blocked, reason };
}
