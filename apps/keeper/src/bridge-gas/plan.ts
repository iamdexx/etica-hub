/**
 * Pure planning for one bridge-gas leg. No I/O: the runner snapshots chain
 * state and quotes, this decides what to do.
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
  minStable: bigint;
  maxSlippageBps: number;
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

export type LegDecision =
  | { action: 'idle'; reason: string; claim: bigint }
  | { action: 'swap'; claim: bigint; amountIn: bigint; minOut: bigint; nativeNeeded: bigint }
  | { action: 'blocked'; reason: string; claim: bigint };

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

export function decideLeg(
  snap: LegSnapshot,
  t: LegThresholds,
  quote: SwapQuote | null,
): LegDecision {
  const claim = claimAmount(snap, t);
  const needed = nativeNeeded(snap, t);
  if (needed === 0n) return { action: 'idle', reason: 'gas above minimum', claim };

  const available = snap.walletStable + claim;
  if (available < t.minStable) {
    return { action: 'blocked', reason: 'no stable to swap: fees have not accrued yet', claim };
  }
  if (!quote) return { action: 'blocked', reason: 'router returned no quote', claim };

  // Spend at most what we have; if that buys less than the full top-up we
  // still take it — some gas beats none.
  const amountIn = quote.amountIn > available ? available : quote.amountIn;
  const impact = priceImpactBps(quote);
  if (impact > BigInt(t.maxSlippageBps)) {
    return {
      action: 'blocked',
      reason: `price impact ${impact} bps exceeds ${t.maxSlippageBps} bps`,
      claim,
    };
  }
  const expectedOut = amountIn === quote.amountIn ? quote.amountOut : (amountIn * quote.amountOut) / quote.amountIn;
  const minOut = (expectedOut * (BPS - BigInt(t.maxSlippageBps))) / BPS;
  if (minOut === 0n) return { action: 'blocked', reason: 'swap too small to price', claim };
  return { action: 'swap', claim, amountIn, minOut, nativeNeeded: needed };
}
