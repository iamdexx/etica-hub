import { describe, it, expect } from 'vitest';
import { priceFromSwap, bucketOf, formatPrice18 } from '../src/prices/price';

describe('priceFromSwap', () => {
  // 18-decimal / 18-decimal symmetric case: 10 base in, 15 quote out -> price = 1.5
  it('computes price from base-in -> quote-out (token0 = base)', () => {
    const r = priceFromSwap(10n * 10n ** 18n, 0n, 0n, 15n * 10n ** 18n, true, 18, 18);
    expect(r).not.toBeNull();
    // 1.5 quote per base = 1.5 * 1e18 = 1_500_000_000_000_000_000
    expect(r?.price18).toBe('1500000000000000000');
    expect(r?.baseAmount.toString()).toBe((10n * 10n ** 18n).toString());
    expect(r?.quoteAmount.toString()).toBe((15n * 10n ** 18n).toString());
  });

  it('computes price from quote-in -> base-out (token0 = base)', () => {
    // user sells 9 quote for 6 base -> price = 9/6 = 1.5 quote per base
    const r = priceFromSwap(0n, 9n * 10n ** 18n, 6n * 10n ** 18n, 0n, true, 18, 18);
    expect(r).not.toBeNull();
    expect(r?.price18).toBe('1500000000000000000');
    expect(r?.baseAmount.toString()).toBe((6n * 10n ** 18n).toString());
    expect(r?.quoteAmount.toString()).toBe((9n * 10n ** 18n).toString());
  });

  it('computes price when token1 is base (reversed sides)', () => {
    // base = token1, quote = token0.
    // swap base-in -> quote-out on a Uniswap pair with token1=base, token0=quote:
    //   amount1In > 0 (base in), amount0Out > 0 (quote out)
    const r = priceFromSwap(0n, 10n * 10n ** 18n, 15n * 10n ** 18n, 0n, false, 18, 18);
    expect(r).not.toBeNull();
    expect(r?.price18).toBe('1500000000000000000');
  });

  it('handles decimal mismatch (6-decimal quote)', () => {
    // base = 18 decimals, quote = 6 decimals.
    // 10 base in = 10 * 1e18 wei. 15 quote out = 15 * 1e6 units.
    // Raw ratio quote/base in token-wei = 15e6 / 10e18 = 1.5e-12.
    // True price in "quote per base" = 1.5 quote per base, so price18 = 1.5 * 1e18.
    const r = priceFromSwap(10n * 10n ** 18n, 0n, 0n, 15n * 10n ** 6n, true, 18, 6);
    expect(r).not.toBeNull();
    expect(r?.price18).toBe('1500000000000000000');
  });

  it('returns null on degenerate log (no flows on either side)', () => {
    const r = priceFromSwap(0n, 0n, 0n, 0n, true, 18, 18);
    expect(r).toBeNull();
  });

  it('returns null on inconsistent log (both sides in)', () => {
    const r = priceFromSwap(1n, 1n, 0n, 0n, true, 18, 18);
    expect(r).toBeNull();
  });
});

describe('bucketOf', () => {
  it('aligns to minute start', () => {
    // 1_700_000_040 is minute-aligned (divisible by 60).
    expect(bucketOf(1_700_000_040)).toBe(1_700_000_040);
    expect(bucketOf(1_700_000_041)).toBe(1_700_000_040);
    expect(bucketOf(1_700_000_099)).toBe(1_700_000_040);
    expect(bucketOf(1_700_000_100)).toBe(1_700_000_100);
  });
});

describe('formatPrice18', () => {
  it('formats a fixed-18 string as a human decimal', () => {
    expect(formatPrice18('1500000000000000000')).toBe('1.5');
    expect(formatPrice18('0')).toBe('0');
    expect(formatPrice18('1000000000000000000')).toBe('1');
  });
});
