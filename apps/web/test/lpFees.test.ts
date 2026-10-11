import { describe, expect, it } from 'vitest';
import { computeLpFeesEarned, invariantUnits } from '../src/lib/lpFees';

const E18 = 10n ** 18n;

describe('computeLpFeesEarned', () => {
  it('returns null when the wallet never minted LP here', () => {
    expect(
      computeLpFeesEarned({
        reserve0: 100n * E18,
        reserve1: 100n * E18,
        totalSupply: 100n * E18,
        lpBalance: 10n * E18,
        adds: [],
        removes: [],
        untrackedLpTransfers: true,
      }),
    ).toBeNull();
  });

  it('reads zero fees right after a deposit', () => {
    const fees = computeLpFeesEarned({
      reserve0: 110n * E18,
      reserve1: 110n * E18,
      totalSupply: 110n * E18,
      lpBalance: 10n * E18,
      adds: [
        { lp: 10n * E18, totalSupply: 110n * E18, reserve0: 110n * E18, reserve1: 110n * E18 },
      ],
      removes: [],
      untrackedLpTransfers: false,
    });
    expect(fees).not.toBeNull();
    expect(fees!.consistent).toBe(true);
    expect(fees!.pctOfDeposits).toBeCloseTo(0, 6);
    expect(fees!.fee0).toBe(0n);
  });

  it('ignores pure price moves (impermanent loss is not fees)', () => {
    // Pool 100/100, user holds 10%. Price doubles with no fees: k constant,
    // reserves become ~70.71 / 141.42.
    const r0 = 70_710_678_118_654_752n * 1_000n; // 70.71e18
    const r1 = 141_421_356_237_309_505n * 1_000n; // 141.42e18
    const fees = computeLpFeesEarned({
      reserve0: r0,
      reserve1: r1,
      totalSupply: 100n * E18,
      lpBalance: 10n * E18,
      adds: [
        { lp: 10n * E18, totalSupply: 100n * E18, reserve0: 100n * E18, reserve1: 100n * E18 },
      ],
      removes: [],
      untrackedLpTransfers: false,
    });
    expect(fees!.pctOfDeposits).toBeCloseTo(0, 5);
  });

  it('attributes invariant growth to fees and prices it at the current ratio', () => {
    // Deposited 10/10 into 100/100. Fees then grow reserves 1% each side with
    // supply unchanged → position L grew 1%.
    const fees = computeLpFeesEarned({
      reserve0: 101n * E18,
      reserve1: 101n * E18,
      totalSupply: 100n * E18,
      lpBalance: 10n * E18,
      adds: [
        { lp: 10n * E18, totalSupply: 100n * E18, reserve0: 100n * E18, reserve1: 100n * E18 },
      ],
      removes: [],
      untrackedLpTransfers: false,
    });
    expect(fees!.pctOfDeposits).toBeCloseTo(1, 6);
    // 1% of 10 tokens, each side.
    expect(Number(fees!.fee0) / 1e18).toBeCloseTo(0.1, 6);
    expect(Number(fees!.fee1) / 1e18).toBeCloseTo(0.1, 6);
    expect(fees!.consistent).toBe(true);
  });

  it('keeps fees realised on a partial withdrawal in the lifetime figure', () => {
    // Deposit 10/10 (L=10). Fees take L to 10.5; user burns half and gets
    // 5.25/5.25 back. Remaining position L = 5.25 → fees = 5.25 + 5.25 − 10.
    const fees = computeLpFeesEarned({
      reserve0: 105n * E18,
      reserve1: 105n * E18,
      totalSupply: 100n * E18,
      lpBalance: 5n * E18,
      adds: [
        { lp: 10n * E18, totalSupply: 100n * E18, reserve0: 100n * E18, reserve1: 100n * E18 },
      ],
      removes: [{ amount0: 5_250_000_000_000_000_000n, amount1: 5_250_000_000_000_000_000n }],
      untrackedLpTransfers: false,
    });
    expect(fees!.pctOfDeposits).toBeCloseTo(5, 6);
  });

  it('flags a position that holds less L than it deposited (LP sent elsewhere)', () => {
    const fees = computeLpFeesEarned({
      reserve0: 100n * E18,
      reserve1: 100n * E18,
      totalSupply: 100n * E18,
      lpBalance: 1n * E18,
      adds: [
        { lp: 10n * E18, totalSupply: 100n * E18, reserve0: 100n * E18, reserve1: 100n * E18 },
      ],
      removes: [],
      untrackedLpTransfers: true,
    });
    expect(fees!.consistent).toBe(false);
    expect(fees!.fee0).toBe(0n);
  });

  it("does not count protocol-fee LP minted to feeTo as that wallet's deposit basis", () => {
    // feeTo received 1 LP in a tx that left the pool at 101/101 with supply 101:
    // its basis is exactly its share then, so fees right after are zero.
    const fees = computeLpFeesEarned({
      reserve0: 101n * E18,
      reserve1: 101n * E18,
      totalSupply: 101n * E18,
      lpBalance: 1n * E18,
      adds: [{ lp: 1n * E18, totalSupply: 101n * E18, reserve0: 101n * E18, reserve1: 101n * E18 }],
      removes: [],
      untrackedLpTransfers: false,
    });
    expect(fees!.pctOfDeposits).toBeCloseTo(0, 6);
  });

  it('handles mixed decimals (6-dec / 18-dec) without overflow', () => {
    const usdc = 20_000_000n; // 20 USDC.e
    const etx = 5_000n * E18;
    expect(invariantUnits(usdc, etx)).toBeGreaterThan(0);
    const fees = computeLpFeesEarned({
      reserve0: usdc + usdc / 100n,
      reserve1: etx + etx / 100n,
      totalSupply: 1_000_000n * E18,
      lpBalance: 1_000_000n * E18,
      adds: [
        { lp: 1_000_000n * E18, totalSupply: 1_000_000n * E18, reserve0: usdc, reserve1: etx },
      ],
      removes: [],
      untrackedLpTransfers: false,
    });
    expect(fees!.pctOfDeposits).toBeCloseTo(1, 6);
    expect(Number(fees!.fee0) / 1e6).toBeCloseTo(0.2, 4);
    expect(Number(fees!.fee1) / 1e18).toBeCloseTo(50, 4);
  });
});
