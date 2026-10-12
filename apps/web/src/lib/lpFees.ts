/**
 * Lifetime swap-fee income of one wallet's position in a constant-product
 * (V2) pool, derived purely from that wallet's own LP history.
 *
 * A V2 LP position can be measured in "invariant units"
 * L = lp / totalSupply · sqrt(reserve0 · reserve1). Price moves (and so
 * impermanent loss) leave L untouched — the only thing that grows L for a
 * fixed number of LP tokens is swap fees staying in the reserves (net of the
 * protocol-fee LP minted to feeTo, which dilutes totalSupply). So
 *
 *   feesL = L_now + Σ L_removed − Σ L_added
 *
 * is the fee income earned since the first deposit. L_added is read from
 * each LP mint (LP received, reserves and supply right after it) and
 * L_removed from each Burn's pro-rata amounts, so no historical state reads
 * are needed. feesL is converted to tokens at the current pool ratio.
 */

export interface LpAdd {
  /** LP tokens received. */
  lp: bigint;
  /** Pool state at the end of the transaction that minted them. */
  totalSupply: bigint;
  reserve0: bigint;
  reserve1: bigint;
}

export interface LpRemove {
  amount0: bigint;
  amount1: bigint;
}

/**
 * A `sync()` that followed tokens sent straight to the pair (no Swap/Mint/Burn
 * in the same tx). It grows every LP holder's share without any trade having
 * paid a fee, so the wallet's pro-rata slice is backed out of the fee figure.
 */
export interface LpDonation {
  reserve0Before: bigint;
  reserve1Before: bigint;
  reserve0After: bigint;
  reserve1After: bigint;
  /** Wallet LP (incl. farm-staked) and LP total supply at that moment. */
  userLp: bigint;
  totalSupply: bigint;
}

export interface LpFeesInput {
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  /** Wallet LP + farm-staked LP. */
  lpBalance: bigint;
  adds: LpAdd[];
  removes: LpRemove[];
  donations?: LpDonation[];
  /**
   * LP tokens moved in/out of the wallet other than via mint, burn or farm
   * staking — their basis is unknown, so the figure is only a lower bound
   * (or meaningless if LP left the wallet).
   */
  untrackedLpTransfers: boolean;
}

export interface LpFeesEarned {
  /** Fee income expressed in token0 base units at the current pool ratio. */
  fee0: bigint;
  /** Fee income expressed in token1 base units at the current pool ratio. */
  fee1: bigint;
  /** feesL / Σ L_added, as a percent (e.g. 1.25). */
  pctOfDeposits: number;
  /** Position still holds at least the L it deposited (false → LP left the wallet). */
  consistent: boolean;
  untrackedLpTransfers: boolean;
}

export function invariantUnits(amount0: bigint, amount1: bigint): number {
  return Math.sqrt(Number(amount0) * Number(amount1));
}

export function positionInvariantUnits(
  lpBalance: bigint,
  totalSupply: bigint,
  reserve0: bigint,
  reserve1: bigint,
): number {
  if (totalSupply === 0n) return 0;
  return (Number(lpBalance) / Number(totalSupply)) * invariantUnits(reserve0, reserve1);
}

const toWei = (x: number): bigint => (Number.isFinite(x) ? BigInt(Math.round(x)) : 0n);

/** null when the wallet never minted LP in this pool (nothing to measure against). */
export function computeLpFeesEarned(input: LpFeesInput): LpFeesEarned | null {
  const added = input.adds.reduce(
    (s, a) => s + positionInvariantUnits(a.lp, a.totalSupply, a.reserve0, a.reserve1),
    0,
  );
  if (added <= 0) return null;
  const removed = input.removes.reduce((s, r) => s + invariantUnits(r.amount0, r.amount1), 0);
  const now = positionInvariantUnits(
    input.lpBalance,
    input.totalSupply,
    input.reserve0,
    input.reserve1,
  );
  const donated = (input.donations ?? []).reduce((s, d) => {
    if (d.totalSupply === 0n) return s;
    const deltaL =
      invariantUnits(d.reserve0After, d.reserve1After) -
      invariantUnits(d.reserve0Before, d.reserve1Before);
    return s + (Number(d.userLp) / Number(d.totalSupply)) * Math.max(deltaL, 0);
  }, 0);
  const feesL = now + removed - added - donated;
  // Float noise on a brand-new deposit can land a hair below zero.
  const consistent = feesL >= -added * 1e-9;
  const sqrtK = invariantUnits(input.reserve0, input.reserve1);
  const clamped = Math.max(feesL, 0);
  return {
    fee0: sqrtK > 0 ? toWei((clamped * Number(input.reserve0)) / sqrtK) : 0n,
    fee1: sqrtK > 0 ? toWei((clamped * Number(input.reserve1)) / sqrtK) : 0n,
    pctOfDeposits: (clamped / added) * 100,
    consistent,
    untrackedLpTransfers: input.untrackedLpTransfers,
  };
}
