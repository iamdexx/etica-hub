import { describe, expect, it } from 'vitest';
import { parseUnits, type Address } from 'viem';
import { stableSwapSnapshot } from '../src/lib/seo/market';

const POOL = '0xbbf5814C1EA0531Cb07541b80c547ee7878C036E' as Address;

describe('stableSwapSnapshot', () => {
  const state = {
    address: POOL,
    reserveEtx: parseUnits('10000000', 18),
    reserveStEtx: parseUnits('18000000', 18),
    rate: parseUnits('1.1', 18),
    lpSupply: parseUnits('28000000', 18),
    asOfTs: 1_700_000_000,
  };

  it('values the stETX leg at the live rate and quotes NAV as the price', () => {
    const p = stableSwapSnapshot(state, 0.002);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('stableswap');
    expect(p!.token0.symbol).toBe('stETX');
    expect(p!.token1.symbol).toBe('ETX');
    expect(p!.reserve0).toBe(18_000_000);
    expect(p!.reserve1).toBe(10_000_000);
    expect(p!.price0In1).toBeCloseTo(1.1, 12);
    expect(p!.price1In0).toBeCloseTo(1 / 1.1, 12);
    // 10M ETX + 18M stETX × 1.1 = 29.8M ETX-equivalent
    expect(p!.tvlEtx).toBeCloseTo(29_800_000, 6);
    expect(p!.tvlUsd).toBeCloseTo(59_600, 6);
    expect(p!.lpSupply).toBe(28_000_000);
    expect(p!.lastSyncTs).toBe(1_700_000_000);
  });

  it('leaves USD null when ETX has no USD anchor', () => {
    expect(stableSwapSnapshot(state, null)!.tvlUsd).toBeNull();
  });

  it('returns null for an uninitialised pool', () => {
    expect(stableSwapSnapshot({ ...state, rate: 0n }, 0.002)).toBeNull();
    expect(stableSwapSnapshot({ ...state, reserveEtx: 0n, reserveStEtx: 0n }, 0.002)).toBeNull();
  });
});
