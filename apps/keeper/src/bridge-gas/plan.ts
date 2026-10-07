/**
 * Pure planning for one bridge-gas leg. No I/O: the runner snapshots chain
 * state and quotes, this decides what to do.
 *
 * Per run, in order:
 *   1. claim   — sweep the fee contract into the keeper wallet once it holds
 *                at least `minStable` (amortises Ethereum gas)
 *   2. swap    — if native gas (keeper's, plus the relayer's shortfall) is
 *                under `minNative`, swap just enough stable for wrapped
 *                native (bounded by price impact + slippage)
 *   2b. relayer — send the relayer up to its target from the keeper's gas,
 *                never below the keeper's own floor
 *   3. surplus — everything left above `reserveStable` is converted to EGAZ:
 *                on Etica it is swapped (USDC.e -> ETX -> WEGAZ -> EGAZ) in
 *                bounded chunks and kept in the keeper wallet, with no upper
 *                target; on Ethereum it is bridged to the keeper's Etica
 *                wallet so the next Etica run swaps it there. Nothing ever
 *                leaves the keeper.
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
  /** Relayer's native balance (wei), when the leg refuels a separate relayer. */
  relayerNative?: bigint;
}

export interface LegThresholds {
  minNative: bigint;
  targetNative: bigint;
  /** Don't claim / swap amounts below this (stable units). */
  minStable: bigint;
  maxSlippageBps: number;
  /** Stable kept in the wallet for future top-ups; only the excess leaves. */
  reserveStable: bigint;
  /** Only swap / bridge the surplus when it is at least this. */
  minSweep: bigint;
  /** Relayer floor/target; the shortfall is added to what the swap must buy. */
  relayer?: { minNative: bigint; targetNative: bigint } | null;
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
  /** Stable above the reserve after claim + swap: swapped to EGAZ on Etica, bridged on Ethereum (0 = skip). */
  surplus: bigint;
  /** Why no swap was planned although gas is low (null otherwise). */
  blocked: string | null;
  reason: string;
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

/** Relayer's native shortfall to reach its target; 0 when healthy or not refuelled from this leg. */
export function relayerNeeded(snap: LegSnapshot, t: LegThresholds): bigint {
  if (!t.relayer || snap.relayerNative === undefined) return 0n;
  if (snap.relayerNative >= t.relayer.minNative) return 0n;
  return t.relayer.targetNative - snap.relayerNative;
}

/**
 * Native shortfall the swap must cover: the keeper's own top-up plus
 * whatever the relayer needs that the keeper's spare gas (above its floor)
 * cannot already pay. 0 when both are healthy.
 */
export function nativeNeeded(snap: LegSnapshot, t: LegThresholds): bigint {
  const own = snap.nativeBalance < t.minNative ? t.targetNative - snap.nativeBalance : 0n;
  const relayer = relayerNeeded(snap, t);
  if (relayer === 0n) return own;
  const spare = snap.nativeBalance > t.minNative ? snap.nativeBalance - t.minNative : 0n;
  return own + (relayer > spare ? relayer - spare : 0n);
}

/**
 * Gas to send the relayer right now: its shortfall, capped by what the
 * keeper holds above its own floor after paying for the transfer itself
 * (`feeBuffer`), so refuelling the relayer can never strand the keeper.
 */
export function relayerTopUp(keeperNative: bigint, relayerNative: bigint, t: LegThresholds, feeBuffer = 0n): bigint {
  const need = relayerNeeded({ nativeBalance: keeperNative, feeContractBalance: 0n, walletStable: 0n, keeperOwnsFeeContract: false, relayerNative }, t);
  if (need === 0n) return 0n;
  const floor = t.minNative + feeBuffer;
  const spare = keeperNative > floor ? keeperNative - floor : 0n;
  return need < spare ? need : spare;
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
 * One chunk of surplus -> native. Bounded by `maxChunk` per run and by the
 * same price-impact ceiling as the gas swap; a thin pool makes the keeper
 * hold the stable (or the runner retries a smaller chunk), never dump it.
 */
export function planSurplusSwap(
  surplus: bigint,
  maxChunk: bigint,
  minSweep: bigint,
  quote: SwapQuote | null,
  maxSlippageBps: number,
): { plan: SwapPlan | null; blocked: string | null } {
  if (surplus <= 0n) return { plan: null, blocked: null };
  const amountIn = surplus > maxChunk ? maxChunk : surplus;
  if (amountIn < minSweep) return { plan: null, blocked: 'surplus chunk below minimum' };
  if (!quote || quote.amountIn !== amountIn) return { plan: null, blocked: 'router returned no quote' };
  const impact = priceImpactBps(quote);
  if (impact > BigInt(maxSlippageBps)) {
    return { plan: null, blocked: `surplus swap price impact ${impact} bps exceeds ${maxSlippageBps} bps` };
  }
  const minOut = withSlippage(quote.amountOut, maxSlippageBps);
  if (minOut === 0n) return { plan: null, blocked: 'swap too small to price' };
  return { plan: { amountIn, minOut, nativeNeeded: 0n }, blocked: null };
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
