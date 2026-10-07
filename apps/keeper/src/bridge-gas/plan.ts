/**
 * Pure planning for one bridge-gas leg. No I/O: the runner snapshots chain
 * state and quotes, this decides what to do.
 *
 * Per run, in order:
 *   1. claim   — sweep the fee contract into the keeper wallet once it holds
 *                at least `minStable` (amortises Ethereum gas)
 *   2. swap    — if native gas is under `minNative`, swap just enough stable
 *                for wrapped native (bounded by price impact + slippage)
 *   3. sweep   — everything left above `reserveStable` goes to the treasury,
 *                as a plain token transfer; the treasury never signs
 */

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
  /** Stable kept in the wallet for future top-ups; only the excess is swept. */
  reserveStable: bigint;
  /** Only sweep to the treasury when the excess is at least this. */
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
  /** Stable to transfer to the treasury after claim + swap (0 = skip). */
  sweep: bigint;
  /** Why no swap was planned although gas is low (null otherwise). */
  blocked: string | null;
  reason: string;
}

const BPS = 10_000n;

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
 * Treasury sweep: whatever stable the wallet will hold after claim + swap,
 * minus the operating reserve. Never sweeps while a needed swap is blocked —
 * the stable is held so a later run can still buy gas.
 */
export function sweepAmount(
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

  const sweep = sweepAmount(snap, t, claim, swap?.amountIn ?? 0n, blocked !== null);
  return { claim, swap, sweep, blocked, reason };
}
