import { describe, expect, it } from 'vitest';
import {
  filterSamplesToWindow,
  formatPriceRatio,
  invertPrice,
  priceHeadline,
} from '../src/lib/trading/priceLabel';

describe('formatPriceRatio', () => {
  it('returns the em-dash sentinel for non-finite or non-positive inputs', () => {
    expect(formatPriceRatio(Number.NaN)).toBe('—');
    expect(formatPriceRatio(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatPriceRatio(0)).toBe('—');
    expect(formatPriceRatio(-1)).toBe('—');
  });

  it('uses 2 decimals at >= 100', () => {
    expect(formatPriceRatio(100)).toBe('100.00');
    expect(formatPriceRatio(3720)).toBe('3720.00');
  });

  it('uses 4 decimals between 1 and 100', () => {
    expect(formatPriceRatio(64.7246)).toBe('64.7246');
    expect(formatPriceRatio(1)).toBe('1.0000');
  });

  it('uses 6 decimals below 1', () => {
    expect(formatPriceRatio(0.01546)).toBe('0.015460');
    expect(formatPriceRatio(0.000123)).toBe('0.000123');
  });
});

describe('priceHeadline', () => {
  it('renders the canonical "1 BASE = N QUOTE" form by default', () => {
    expect(
      priceHeadline({ base: 'ETI', quote: 'ETX', latest: 64.7246, inverted: false }),
    ).toBe('1 ETI = 64.7246 ETX');
  });

  it('renders the reciprocal "1 QUOTE = N BASE" form when inverted', () => {
    expect(
      priceHeadline({ base: 'ETI', quote: 'ETX', latest: 0.01546, inverted: true }),
    ).toBe('1 ETX = 0.015460 ETI');
  });

  it('returns an em-dash sentinel for non-positive prices', () => {
    expect(
      priceHeadline({ base: 'ETI', quote: 'ETX', latest: 0, inverted: false }),
    ).toBe('—');
    expect(
      priceHeadline({ base: 'ETI', quote: 'ETX', latest: Number.NaN, inverted: true }),
    ).toBe('—');
  });
});

describe('invertPrice', () => {
  it('returns the multiplicative inverse for positive finite inputs', () => {
    expect(invertPrice(2)).toBe(0.5);
    expect(invertPrice(64.7246)).toBeCloseTo(1 / 64.7246, 12);
  });

  it('returns 0 for non-finite or non-positive inputs', () => {
    expect(invertPrice(0)).toBe(0);
    expect(invertPrice(-1)).toBe(0);
    expect(invertPrice(Number.NaN)).toBe(0);
    expect(invertPrice(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('filterSamplesToWindow', () => {
  // Frozen "now" for determinism. 2024-06-01 00:00:00 UTC.
  const NOW = 1717200000;
  const samples = [
    { ts: NOW - 60 * 24 * 60 * 60, price: 3720 }, // 60d ago — outlier
    { ts: NOW - 14 * 24 * 60 * 60, price: 200 }, // 14d ago
    { ts: NOW - 5 * 24 * 60 * 60, price: 100 }, // 5d ago
    { ts: NOW - 12 * 60 * 60, price: 70 }, // 12h ago
    { ts: NOW - 60, price: 64.7246 }, // 1m ago
  ];

  it('returns all samples for window "all"', () => {
    expect(filterSamplesToWindow(samples, 'all', (s) => s.ts, NOW)).toEqual(samples);
  });

  it('drops samples older than 24h for "24h"', () => {
    const out = filterSamplesToWindow(samples, '24h', (s) => s.ts, NOW);
    expect(out.map((s) => s.price)).toEqual([70, 64.7246]);
  });

  it('drops samples older than 7d for "7d" (excludes 14d-ago and 60d-ago outliers)', () => {
    const out = filterSamplesToWindow(samples, '7d', (s) => s.ts, NOW);
    expect(out.map((s) => s.price)).toEqual([100, 70, 64.7246]);
  });

  it('drops the 60d-ago outlier for "30d"', () => {
    const out = filterSamplesToWindow(samples, '30d', (s) => s.ts, NOW);
    expect(out.map((s) => s.price)).toEqual([200, 100, 70, 64.7246]);
  });

  it('returns empty when no samples are in the window', () => {
    const old = [{ ts: NOW - 100 * 24 * 60 * 60, price: 100 }];
    expect(filterSamplesToWindow(old, '24h', (s) => s.ts, NOW)).toEqual([]);
  });
});
