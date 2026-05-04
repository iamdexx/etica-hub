/**
 * Pure price + market-cap math for the buy bot.
 *
 * Inputs: a single `Swap` event and the pool's pre-swap reserves (implied by
 * the event's `amountXIn/Out` values: post = pre + in - out → pre = post + out - in).
 * Outputs: which token was bought (the "out" leg), at what price in the other
 * token, in ETX, in USD, plus the market caps of both tokens.
 *
 * All math uses plain `number` for the final reporting figures — good enough
 * for a Telegram message, not enough for anything that settles on-chain.
 */

import { getAddress, type Address } from 'viem';

export interface TokenMeta {
  address: Address;
  symbol: string;
  decimals: number;
  /** Fully diluted total supply, normalized by decimals. */
  totalSupply: bigint;
}

/** A raw Uniswap V2 Swap event, as returned by viem log decoding. */
export interface SwapEventArgs {
  sender: Address;
  to: Address;
  amount0In: bigint;
  amount0Out: bigint;
  amount1In: bigint;
  amount1Out: bigint;
}

export interface PoolSnapshot {
  pair: Address;
  token0: TokenMeta;
  token1: TokenMeta;
  /**
   * Reserves at the block the Swap landed in (i.e. AFTER the swap).
   * We back-compute pre-swap reserves from the event amounts to price the
   * trade at what the pool charged, not what the pool looks like after.
   */
  reserve0After: bigint;
  reserve1After: bigint;
}

export interface DecodedBuy {
  /** Token the swapper bought (received). */
  bought: TokenMeta;
  /** Token the swapper spent. */
  spent: TokenMeta;
  /** Amount of `bought` received, raw (unnormalized) bigint. */
  amountBought: bigint;
  /** Amount of `spent` paid, raw (unnormalized) bigint. */
  amountSpent: bigint;
  /**
   * Pre-swap price of `bought` denominated in `spent`, from reserves.
   * Example: ETX bought with ETI → price is ETI-per-ETX before the trade.
   */
  pricePreInSpent: number;
}

function toUnits(raw: bigint, decimals: number): number {
  // Safe for 18-decimal tokens up to ~1e18 units; for our Telegram display
  // we only need 4 significant figures so precision loss is irrelevant.
  if (raw === 0n) return 0;
  const scale = 10 ** decimals;
  return Number(raw) / scale;
}

/**
 * Classify a Swap event into a buy (the "Out" side is the token bought).
 *
 * Uniswap V2 guarantees at most one of the two "Out" amounts is nonzero in
 * practice (a swap always sends exactly one asset out). We guard the edge
 * cases anyway (both zero, both nonzero) because the pair contract does
 * technically allow the malformed shape.
 */
export function decodeSwapAsBuy(pool: PoolSnapshot, args: SwapEventArgs): DecodedBuy | null {
  const t0Out = args.amount0Out;
  const t1Out = args.amount1Out;
  const t0In = args.amount0In;
  const t1In = args.amount1In;

  let bought: TokenMeta;
  let spent: TokenMeta;
  let amountBought: bigint;
  let amountSpent: bigint;
  let reserveBoughtPre: bigint;
  let reserveSpentPre: bigint;

  if (t0Out > 0n && t1Out === 0n) {
    bought = pool.token0;
    spent = pool.token1;
    amountBought = t0Out;
    amountSpent = t1In;
    reserveBoughtPre = pool.reserve0After + t0Out - t0In;
    reserveSpentPre = pool.reserve1After + t1Out - t1In;
  } else if (t1Out > 0n && t0Out === 0n) {
    bought = pool.token1;
    spent = pool.token0;
    amountBought = t1Out;
    amountSpent = t0In;
    reserveBoughtPre = pool.reserve1After + t1Out - t1In;
    reserveSpentPre = pool.reserve0After + t0Out - t0In;
  } else {
    return null;
  }

  if (reserveBoughtPre <= 0n || reserveSpentPre <= 0n) return null;

  const rb = toUnits(reserveBoughtPre, bought.decimals);
  const rs = toUnits(reserveSpentPre, spent.decimals);
  if (rb === 0 || rs === 0) return null;

  return {
    bought,
    spent,
    amountBought,
    amountSpent,
    pricePreInSpent: rs / rb,
  };
}

export interface UsdPricing {
  etxUsd: number | null;
  etiUsd: number | null;
  egazUsd: number | null;
}

/** Resolve any `TokenMeta` to a USD price given an anchored {@link UsdPricing}. */
export function usdPriceOf(
  token: TokenMeta,
  etx: Address,
  eti: Address,
  wegaz: Address,
  pricing: UsdPricing,
): number | null {
  const a = getAddress(token.address);
  if (a === getAddress(etx)) return pricing.etxUsd ?? null;
  if (a === getAddress(eti)) return pricing.etiUsd ?? null;
  if (a === getAddress(wegaz)) return pricing.egazUsd ?? null;
  // Launchpad tokens don't have a direct USD anchor; price them via ETX.
  return null;
}

/**
 * Optional overrides used when a token's on-chain `totalSupply()` doesn't
 * reflect the asset's true economic supply.
 *
 * `wegazNativeSupply` swaps in the chain's native EGAZ supply (read from
 * the BlockScout `coinsupply` endpoint) because the WEGAZ ERC-20 only
 * counts the wrapped slice (~10% of native supply at time of writing).
 *
 * `excludedSupplyByToken` removes non-circulating balances from MC math
 * to match the convention aggregators use: subtract the sum of treasury
 * wallet, fee splitter, timelock, and bridge-vault balances from
 * `totalSupply()` before multiplying by price. Keys are checksummed
 * addresses (`getAddress`); values are pre-summed raw 18-decimal-padded
 * `bigint`s so the math at the call site stays symmetric with
 * {@link TokenMeta.totalSupply}.
 *
 * Tokens not present in the map fall through to fully diluted MC, which
 * is the safe default for assets without a defined treasury.
 */
export interface SupplyOverrides {
  wegazNativeSupply?: bigint | null;
  excludedSupplyByToken?: Map<Address, bigint>;
  /**
   * Tokens whose MC line should be hidden entirely. Used for ERC-4626
   * shares (e.g. stETX), where price × supply just reproduces the
   * underlying asset's market cap and would double-count it on
   * cross-token totals. Keys are checksummed addresses.
   */
  hideMcForTokens?: Set<Address>;
}

/**
 * Format a buy + pool snapshot into reporting figures. Pure; safe to unit-test.
 */
export function computeBuyReport(
  decoded: DecodedBuy,
  etx: Address,
  eti: Address,
  wegaz: Address,
  pricing: UsdPricing,
  supplyOverrides: SupplyOverrides = {},
): {
  amountBought: number;
  amountSpent: number;
  pricePerBoughtInSpent: number;
  pricePerBoughtInUsd: number | null;
  notionalUsd: number | null;
  mcBoughtUsd: number | null;
  mcSpentUsd: number | null;
} {
  const amountBought = toUnits(decoded.amountBought, decoded.bought.decimals);
  const amountSpent = toUnits(decoded.amountSpent, decoded.spent.decimals);

  const spentUsd = usdPriceOf(decoded.spent, etx, eti, wegaz, pricing);
  const boughtUsd =
    usdPriceOf(decoded.bought, etx, eti, wegaz, pricing) ??
    (spentUsd !== null ? spentUsd * decoded.pricePreInSpent : null);

  const notionalUsd =
    spentUsd !== null
      ? amountSpent * spentUsd
      : boughtUsd !== null
        ? amountBought * boughtUsd
        : null;

  // For WEGAZ specifically, swap in the native EGAZ supply (when available)
  // so MC reflects the chain's actual economy rather than just the wrapped
  // ERC-20 slice. Falls back to the on-chain totalSupply if the override
  // is missing or zero.
  const wegazLc = getAddress(wegaz).toLowerCase();
  const supplyFor = (token: TokenMeta): bigint => {
    let supply: bigint;
    if (
      supplyOverrides.wegazNativeSupply &&
      supplyOverrides.wegazNativeSupply > 0n &&
      getAddress(token.address).toLowerCase() === wegazLc
    ) {
      supply = supplyOverrides.wegazNativeSupply;
    } else {
      supply = token.totalSupply;
    }
    // Subtract pre-summed non-circulating balances (treasury, harvester,
    // timelocks, bridge vaults). Clamps at 0 so a registry that
    // momentarily over-counts (e.g. snapshot lag during a transfer) can
    // never produce a negative MC.
    const excluded = supplyOverrides.excludedSupplyByToken?.get(getAddress(token.address));
    if (excluded && excluded > 0n) {
      return supply > excluded ? supply - excluded : 0n;
    }
    return supply;
  };

  const hideMc = supplyOverrides.hideMcForTokens;
  const isHidden = (token: TokenMeta) => hideMc?.has(getAddress(token.address)) ?? false;

  const mcBoughtUsd =
    boughtUsd !== null && !isHidden(decoded.bought)
      ? boughtUsd * toUnits(supplyFor(decoded.bought), decoded.bought.decimals)
      : null;
  const mcSpentUsd =
    spentUsd !== null && !isHidden(decoded.spent)
      ? spentUsd * toUnits(supplyFor(decoded.spent), decoded.spent.decimals)
      : null;

  return {
    amountBought,
    amountSpent,
    pricePerBoughtInSpent: decoded.pricePreInSpent,
    pricePerBoughtInUsd: boughtUsd,
    notionalUsd,
    mcBoughtUsd,
    mcSpentUsd,
  };
}
