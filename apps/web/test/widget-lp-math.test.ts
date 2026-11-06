import { describe, expect, it } from 'vitest';
import { burnOutput, protocolFeeMint, sqrtBig } from '../src/lib/widget/lpMath';

const E = 10n ** 18n;

describe('widget LP math', () => {
  it('sqrtBig floors like the pair', () => {
    expect(sqrtBig(0n)).toBe(0n);
    expect(sqrtBig(1n)).toBe(1n);
    expect(sqrtBig(15n)).toBe(3n);
    expect(sqrtBig(16n)).toBe(4n);
    expect(sqrtBig(10n ** 36n)).toBe(10n ** 18n);
  });

  it('mints nothing while the protocol fee is off or k did not grow', () => {
    expect(protocolFeeMint(100n * E, 100n * E, 100n * E, 0n, true)).toBe(0n);
    expect(protocolFeeMint(100n * E, 100n * E, 100n * E, 100n * E * 100n * E, false)).toBe(0n);
    expect(protocolFeeMint(100n * E, 100n * E, 100n * E, 100n * E * 100n * E, true)).toBe(0n);
  });

  it('dilutes the burn by the fee mint when k grew with the fee on', () => {
    // k grew 21% (√k from 100 to 110): fee LP = 100·10 / (550+100) ≈ 1.538
    const r0 = 121n * E, r1 = 100n * E, supply = 100n * E, kLast = 100n * E * 100n * E;
    const mint = protocolFeeMint(r0, r1, supply, kLast, true);
    expect(mint).toBe((supply * 10n * E) / (110n * E * 5n + 100n * E));
    const naive = { amount0: (10n * E * r0) / supply, amount1: (10n * E * r1) / supply };
    const real = burnOutput(10n * E, r0, r1, supply, kLast, true);
    expect(real.amount0).toBeLessThan(naive.amount0);
    expect(real.amount1).toBeLessThan(naive.amount1);
    expect(burnOutput(10n * E, r0, r1, supply, kLast, false)).toEqual(naive);
  });
});
