/**
 * Pure planner for `DirectSwapHarvesterAdapter.harvest(LegPlan[], minTreasuryOut)`.
 *
 * The adapter sells, per listed window, the token0/token1 balances it holds
 * (fees arrive in kind). Two windows can share a token (USDC.e on both live
 * windows): the first listed window sells the whole balance and the sibling
 * finds zero, so only the first occurrence carries a min-out; later ones get
 * zero (their leg amount is zero and the min is never checked).
 *
 * The treasury slice is sold ETX -> treasuryToken on the hub pool whose
 * reserves the fee sale itself just moved, so its quote is computed against
 * post-sale reserves, not the current ones.
 */

import type { Address } from 'viem';
import { estimateSwapOut } from '../harvest/plan.js';

export interface WindowSnapshot {
  pair: Address;
  token0: Address;
  token1: Address;
}

export interface LegQuote {
  token: Address;
  /** Adapter balance of this token. */
  amount: bigint;
  /** Hub `getAmountsOut(amount, [token, etx])[1]`; 0 when the hub cannot price it. */
  etxOut: bigint;
}

export interface HubPoolReserves {
  /** Reserves of the ETX / treasuryToken hub pool before the harvest. */
  etx: bigint;
  treasuryToken: bigint;
}

export interface LegPlan {
  pair: Address;
  minEtxOut0: bigint;
  minEtxOut1: bigint;
  minPolOut0: bigint;
  minPolOut1: bigint;
}

export interface DirectHarvestPlan {
  plans: LegPlan[];
  minTreasuryOut: bigint;
  /** ETX the hub is expected to pay for all legs plus loose ETX already held. */
  expectedEtx: bigint;
  expectedTreasuryOut: bigint;
  skipReason?: string;
}

export function withSlippage(quote: bigint, bps: number): bigint {
  if (bps <= 0 || quote === 0n) return quote;
  return (quote * BigInt(10_000 - bps)) / 10_000n;
}

export function buildDirectHarvestPlan(args: {
  windows: WindowSnapshot[];
  quotes: LegQuote[];
  etx: Address;
  looseEtx: bigint;
  treasuryBps: number;
  treasuryToken: Address | null;
  treasuryPool: HubPoolReserves | null;
  maxSlippageBps: number;
  minEtxWei: bigint;
}): DirectHarvestPlan {
  const quoteOf = new Map(args.quotes.map((q) => [q.token.toLowerCase(), q]));
  const sold = new Set<string>();
  const plans: LegPlan[] = [];
  let expectedEtx = args.looseEtx;

  const legMin = (token: Address): bigint => {
    const key = token.toLowerCase();
    if (key === args.etx.toLowerCase()) {
      return 0n;
    }
    const q = quoteOf.get(key);
    if (!q || q.amount === 0n || q.etxOut === 0n || sold.has(key)) return 0n;
    sold.add(key);
    expectedEtx += q.etxOut;
    return withSlippage(q.etxOut, args.maxSlippageBps);
  };

  for (const w of args.windows) {
    const before = sold.size;
    const minEtxOut0 = legMin(w.token0);
    const minEtxOut1 = legMin(w.token1);
    const hasEtxLeg = [w.token0, w.token1].some((t) => t.toLowerCase() === args.etx.toLowerCase());
    if (sold.size === before && !(hasEtxLeg && args.looseEtx > 0n)) continue;
    plans.push({ pair: w.pair, minEtxOut0, minEtxOut1, minPolOut0: 0n, minPolOut1: 0n });
  }

  if (plans.length === 0 || expectedEtx === 0n) {
    return {
      plans: [],
      minTreasuryOut: 0n,
      expectedEtx,
      expectedTreasuryOut: 0n,
      skipReason: 'nothing the hub can price',
    };
  }
  if (expectedEtx < args.minEtxWei) {
    return {
      plans: [],
      minTreasuryOut: 0n,
      expectedEtx,
      expectedTreasuryOut: 0n,
      skipReason: `below DIRECT_HARVEST_MIN_ETX_WEI (${expectedEtx} < ${args.minEtxWei})`,
    };
  }

  const treasurySlice = (expectedEtx * BigInt(args.treasuryBps)) / 10_000n;
  let expectedTreasuryOut = 0n;
  if (args.treasuryToken && args.treasuryPool && treasurySlice > 0n) {
    const tq = quoteOf.get(args.treasuryToken.toLowerCase());
    const soldTreasuryToken = tq && sold.has(args.treasuryToken.toLowerCase()) ? tq : null;
    const reserveEtx = args.treasuryPool.etx - (soldTreasuryToken?.etxOut ?? 0n);
    const reserveTok = args.treasuryPool.treasuryToken + (soldTreasuryToken?.amount ?? 0n);
    expectedTreasuryOut = estimateSwapOut(treasurySlice, reserveEtx, reserveTok);
  }
  // The adapter pays the slice in ETX when it cannot buy any treasury token,
  // and then ignores minTreasuryOut, so a zero quote is not a reason to stop.
  return {
    plans,
    minTreasuryOut: withSlippage(expectedTreasuryOut, args.maxSlippageBps),
    expectedEtx,
    expectedTreasuryOut,
  };
}
