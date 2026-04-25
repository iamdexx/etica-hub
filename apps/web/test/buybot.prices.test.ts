import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  computeBuyReport,
  decodeSwapAsBuy,
  type PoolSnapshot,
  type SwapEventArgs,
  type TokenMeta,
  type UsdPricing,
} from '../src/lib/buybot/prices';

const ETX = getAddress('0xa5A1Bc6307b0b87989B8456D4b35F88a68650044') as Address;
const ETI = getAddress('0x34c61EA91bAcdA647269d4e310A86b875c09946f') as Address;
const WEGAZ = getAddress('0x232fb2B87CAce92B2438054A7eB79B4081E3E11a') as Address;

const tokenETX: TokenMeta = {
  address: ETX,
  symbol: 'ETX',
  decimals: 18,
  totalSupply: 100_000_000n * 10n ** 18n,
};
const tokenETI: TokenMeta = {
  address: ETI,
  symbol: 'ETI',
  decimals: 18,
  totalSupply: 21_000_000n * 10n ** 18n,
};

/** Helper for a post-swap snapshot of a 10k ETI / 250k ETX pool. */
function pool(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    pair: getAddress('0x000000000000000000000000000000000000dead') as Address,
    token0: tokenETX,
    token1: tokenETI,
    reserve0After: 250_000n * 10n ** 18n,
    reserve1After: 10_000n * 10n ** 18n,
    ...overrides,
  };
}

describe('decodeSwapAsBuy', () => {
  it('returns null when no token was bought (malformed event)', () => {
    const args: SwapEventArgs = {
      sender: ETX,
      to: ETX,
      amount0In: 0n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 0n,
    };
    expect(decodeSwapAsBuy(pool(), args)).toBeNull();
  });

  it('returns null when both tokens were bought (malformed event)', () => {
    const args: SwapEventArgs = {
      sender: ETX,
      to: ETX,
      amount0In: 1n,
      amount0Out: 1n,
      amount1In: 1n,
      amount1Out: 1n,
    };
    expect(decodeSwapAsBuy(pool(), args)).toBeNull();
  });

  it('decodes an ETI-in / ETX-out swap as an ETX buy with correct pre-swap price', () => {
    // Swapper paid 100 ETI to receive 2500 ETX.
    // Pre-swap reserves: 252_500 ETX / 9_900 ETI → price 0.0392 ETI per ETX.
    const args: SwapEventArgs = {
      sender: ETX,
      to: ETX,
      amount0In: 0n,
      amount0Out: 2_500n * 10n ** 18n,
      amount1In: 100n * 10n ** 18n,
      amount1Out: 0n,
    };
    const out = decodeSwapAsBuy(pool(), args);
    expect(out).not.toBeNull();
    if (!out) throw new Error();
    expect(out.bought.symbol).toBe('ETX');
    expect(out.spent.symbol).toBe('ETI');
    expect(out.amountBought).toBe(2_500n * 10n ** 18n);
    expect(out.amountSpent).toBe(100n * 10n ** 18n);
    // 9900 / 252500 ≈ 0.0392
    expect(out.pricePreInSpent).toBeCloseTo(9_900 / 252_500, 8);
  });

  it('decodes an ETX-in / ETI-out swap as an ETI buy with correct pre-swap price', () => {
    const args: SwapEventArgs = {
      sender: ETX,
      to: ETX,
      amount0In: 100n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 4n * 10n ** 18n,
    };
    const out = decodeSwapAsBuy(pool(), args);
    expect(out).not.toBeNull();
    if (!out) throw new Error();
    expect(out.bought.symbol).toBe('ETI');
    expect(out.spent.symbol).toBe('ETX');
  });

  it('returns null if the pool has an empty reserve (pre-seed state)', () => {
    const emptyPool = pool({ reserve0After: 0n, reserve1After: 0n });
    const args: SwapEventArgs = {
      sender: ETX,
      to: ETX,
      amount0In: 0n,
      amount0Out: 1n,
      amount1In: 1n,
      amount1Out: 0n,
    };
    expect(decodeSwapAsBuy(emptyPool, args)).toBeNull();
  });
});

describe('computeBuyReport', () => {
  it('produces notional + MC figures when both sides have a USD anchor', () => {
    const decoded = decodeSwapAsBuy(pool(), {
      sender: ETX,
      to: ETX,
      amount0In: 0n,
      amount0Out: 2_500n * 10n ** 18n,
      amount1In: 100n * 10n ** 18n,
      amount1Out: 0n,
    })!;
    const pricing: UsdPricing = { etxUsd: 0.001, etiUsd: 0.025, egazUsd: null };
    const r = computeBuyReport(decoded, ETX, ETI, WEGAZ, pricing);
    expect(r.amountBought).toBe(2500);
    expect(r.amountSpent).toBe(100);
    expect(r.pricePerBoughtInUsd).toBe(0.001);
    // 100 ETI * $0.025 = $2.50 notional
    expect(r.notionalUsd).toBeCloseTo(2.5, 8);
    // MC ETX = 100M * $0.001 = $100k
    expect(r.mcBoughtUsd).toBeCloseTo(100_000, 4);
    // MC ETI = 21M * $0.025 = $525k
    expect(r.mcSpentUsd).toBeCloseTo(525_000, 4);
  });

  it('derives bought USD price via spent anchor when bought has no direct USD', () => {
    // Make bought a "mystery token" without a direct USD entry.
    const mystery: TokenMeta = {
      address: getAddress('0x0000000000000000000000000000000000001234') as Address,
      symbol: 'XYZ',
      decimals: 18,
      totalSupply: 1_000_000n * 10n ** 18n,
    };
    const p: PoolSnapshot = {
      pair: getAddress('0x000000000000000000000000000000000000dEaD') as Address,
      token0: mystery,
      token1: tokenETX,
      reserve0After: 500_000n * 10n ** 18n,
      reserve1After: 250_000n * 10n ** 18n,
    };
    const decoded = decodeSwapAsBuy(p, {
      sender: ETX,
      to: ETX,
      amount0In: 0n,
      amount0Out: 1_000n * 10n ** 18n,
      amount1In: 500n * 10n ** 18n,
      amount1Out: 0n,
    })!;
    const pricing: UsdPricing = { etxUsd: 0.001, etiUsd: null, egazUsd: null };
    const r = computeBuyReport(decoded, ETX, ETI, WEGAZ, pricing);
    // pricePerBoughtInSpent = 249_500/501_000 = 0.498003... ETX per XYZ
    // boughtUsd = spentUsd * pricePreInSpent (USD/ETX * ETX/XYZ = USD/XYZ)
    //          = $0.001 * 0.498003... ≈ $0.000498003
    expect(r.pricePerBoughtInSpent).toBeCloseTo(249_500 / 501_000, 10);
    expect(r.pricePerBoughtInUsd).not.toBeNull();
    expect(r.pricePerBoughtInUsd!).toBeCloseTo(0.000498003, 8);
    // MC XYZ = 1_000_000 supply * $0.000498 ≈ $498.003
    expect(r.mcBoughtUsd).not.toBeNull();
    expect(r.mcBoughtUsd!).toBeCloseTo(498.003, 2);
    // Notional = amountSpent * spentUsd = 500 ETX * $0.001 = $0.50
    expect(r.notionalUsd).toBeCloseTo(0.5, 8);
  });

  it('uses the WEGAZ native-supply override for MC instead of the wrapped totalSupply', () => {
    // Pool: 1M WEGAZ paired against 1k ETX. WEGAZ totalSupply on-chain
    // (~1.93M today) only counts the wrapped slice; the chain's native
    // EGAZ supply is ~20.16M, which is what we want MC to reflect.
    const wegazWrapped: TokenMeta = {
      address: WEGAZ,
      symbol: 'WEGAZ',
      decimals: 18,
      totalSupply: 1_930_000n * 10n ** 18n,
    };
    const p: PoolSnapshot = {
      pair: getAddress('0x000000000000000000000000000000000000beef') as Address,
      token0: tokenETX,
      token1: wegazWrapped,
      reserve0After: 1_000n * 10n ** 18n,
      reserve1After: 1_000_000n * 10n ** 18n,
    };
    // ETX-in / WEGAZ-out → user buys WEGAZ.
    const decoded = decodeSwapAsBuy(p, {
      sender: ETX,
      to: ETX,
      amount0In: 1n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_000n * 10n ** 18n,
    })!;
    const pricing: UsdPricing = { etxUsd: 1, etiUsd: null, egazUsd: 0.001 };
    const nativeSupply = 20_155_344n * 10n ** 18n;

    const without = computeBuyReport(decoded, ETX, ETI, WEGAZ, pricing);
    // 1.93M * $0.001 = $1,930
    expect(without.mcBoughtUsd).toBeCloseTo(1_930, 4);

    const withOverride = computeBuyReport(decoded, ETX, ETI, WEGAZ, pricing, {
      wegazNativeSupply: nativeSupply,
    });
    // 20.155M * $0.001 ≈ $20,155 — uses native supply, not wrapped slice.
    expect(withOverride.mcBoughtUsd).toBeCloseTo(20_155.344, 2);

    // Override only applies to WEGAZ; ETX-side MC must be untouched even if
    // a (defensive) override is supplied.
    const ethSpentReport = computeBuyReport(
      decodeSwapAsBuy(p, {
        sender: ETX,
        to: ETX,
        amount0In: 0n,
        amount0Out: 1n * 10n ** 18n,
        amount1In: 1_000n * 10n ** 18n,
        amount1Out: 0n,
      })!,
      ETX,
      ETI,
      WEGAZ,
      pricing,
      { wegazNativeSupply: nativeSupply },
    );
    // ETX MC stays 100M * $1 = $100M regardless of WEGAZ override.
    expect(ethSpentReport.mcBoughtUsd).toBeCloseTo(100_000_000, 0);
  });

  it('falls back to the on-chain totalSupply when the WEGAZ override is null/zero', () => {
    const wegazWrapped: TokenMeta = {
      address: WEGAZ,
      symbol: 'WEGAZ',
      decimals: 18,
      totalSupply: 1_930_000n * 10n ** 18n,
    };
    const p: PoolSnapshot = {
      pair: getAddress('0x000000000000000000000000000000000000beef') as Address,
      token0: tokenETX,
      token1: wegazWrapped,
      reserve0After: 1_000n * 10n ** 18n,
      reserve1After: 1_000_000n * 10n ** 18n,
    };
    const decoded = decodeSwapAsBuy(p, {
      sender: ETX,
      to: ETX,
      amount0In: 1n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_000n * 10n ** 18n,
    })!;
    const pricing: UsdPricing = { etxUsd: 1, etiUsd: null, egazUsd: 0.001 };

    for (const override of [null, 0n, undefined]) {
      const r = computeBuyReport(decoded, ETX, ETI, WEGAZ, pricing, {
        wegazNativeSupply: override,
      });
      expect(r.mcBoughtUsd).toBeCloseTo(1_930, 4);
    }
  });

  it('returns null USD figures when no anchor is available for either side', () => {
    const decoded = decodeSwapAsBuy(pool(), {
      sender: ETX,
      to: ETX,
      amount0In: 0n,
      amount0Out: 2_500n * 10n ** 18n,
      amount1In: 100n * 10n ** 18n,
      amount1Out: 0n,
    })!;
    const pricing: UsdPricing = { etxUsd: null, etiUsd: null, egazUsd: null };
    const r = computeBuyReport(decoded, ETX, ETI, WEGAZ, pricing);
    expect(r.notionalUsd).toBeNull();
    expect(r.mcBoughtUsd).toBeNull();
    expect(r.mcSpentUsd).toBeNull();
    expect(r.pricePerBoughtInUsd).toBeNull();
  });
});
