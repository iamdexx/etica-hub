/** Pure arithmetic for the seed run; everything here is unit-tested without a chain. */

const BPS = 10_000n;
const WAD = 10n ** 18n;

export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * (BPS - BigInt(bps))) / BPS;
}

/**
 * Largest transfer whose amount + router fee fits `available`, given the
 * fee quoted at `available` itself. The warp fee is monotonic in the amount,
 * so quoting at the full balance over-estimates and the result always fits.
 */
export function affordableBridgeAmount(available: bigint, feeAtAvailable: bigint): bigint {
  return available > feeAtAvailable ? available - feeAtAvailable : 0n;
}

/** ETX the wallet must hold: the pool side plus the factory fee when this call opens the pair. */
export function etxRequired(
  etxAmount: bigint,
  pair: { exists: boolean; creationFee: bigint; feeToSet: boolean; routerTrusted: boolean },
): bigint {
  const feeDue = !pair.exists && pair.creationFee > 0n && pair.feeToSet && !pair.routerTrusted;
  return etxAmount + (feeDue ? pair.creationFee : 0n);
}

/** Pool price in USD per ETX (1e18 fixed point) from the seed amounts. */
export function poolUsdPerEtx(usdce: bigint, stableDecimals: number, etx: bigint): bigint {
  if (etx === 0n) return 0n;
  return (usdce * WAD * 10n ** BigInt(18 - stableDecimals)) / etx;
}

/** Market price in USD per ETX (1e18) from the ETX->WEGAZ quote for 1 ETX and an EGAZ/USD anchor (1e18). */
export function marketUsdPerEtx(wegazPerEtx: bigint, egazUsd: bigint): bigint {
  return (wegazPerEtx * egazUsd) / WAD;
}

/** |pool - market| / market in BPS; `null` when there is no market price to compare against. */
export function priceDeviationBps(pool: bigint, market: bigint): bigint | null {
  if (market === 0n) return null;
  const diff = pool > market ? pool - market : market - pool;
  return (diff * BPS) / market;
}
