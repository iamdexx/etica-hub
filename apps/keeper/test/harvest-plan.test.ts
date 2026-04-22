import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  buildHarvestPlan,
  estimateBurnOut,
  estimateSwapOut,
  type PairSnapshot,
} from '../src/harvest/plan.js';
import type { HarvestConfig } from '../src/harvest/config.js';

const TREASURY: Address = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';
const ETX: Address = '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044';
const ETI: Address = '0x34c61EA91bAcdA647269d4e310A86b875c09946f';
const WEGAZ: Address = '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a';
const ROUTER: Address = '0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723';
const FACTORY: Address = '0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3';
const ETI_PAIR: Address = '0x88f179117BE4402a71ca3e9094E7942D03Db84b3';
const WEGAZ_PAIR: Address = '0xa18050ABE8d4b9384fE3b88D3b88eC311e8CcdF8';
const STAKED_ETX: Address = '0x1111111111111111111111111111111111111111';

const BASE_CONFIG: HarvestConfig = {
  rpcUrl: 'https://rpc',
  chainId: 61803,
  treasury: TREASURY,
  etx: ETX,
  eti: ETI,
  wegaz: WEGAZ,
  router: ROUTER,
  factory: FACTORY,
  stakedEtx: STAKED_ETX,
  farms: null,
  split: { stakedEtxBps: 1000, farmsBps: 1000, polBurnBps: 4000, treasuryBps: 4000 },
  burnBpsPerRun: 100,
  maxSlippageBps: 300,
  polWeighting: 'treasury_lp',
  privateKey: null,
  dryRun: true,
};

function mkSnap(
  label: string,
  pair: Address,
  nonEtx: Address,
  treasuryLp: bigint,
  reserveEtx: bigint,
  reserveNonEtx: bigint,
  totalSupply: bigint,
): PairSnapshot {
  return { label, pair, nonEtx, reserveEtx, reserveNonEtx, totalSupply, treasuryLp };
}

describe('estimateBurnOut', () => {
  it('returns proportional underlying from LP burn', () => {
    const { etxOut, nonEtxOut } = estimateBurnOut(100n, {
      label: 'x',
      pair: ETI_PAIR,
      nonEtx: ETI,
      reserveEtx: 1000n,
      reserveNonEtx: 500n,
      totalSupply: 1000n,
      treasuryLp: 0n,
    });
    expect(etxOut).toBe(100n);
    expect(nonEtxOut).toBe(50n);
  });

  it('returns zero on empty pool', () => {
    const { etxOut, nonEtxOut } = estimateBurnOut(100n, {
      label: 'x',
      pair: ETI_PAIR,
      nonEtx: ETI,
      reserveEtx: 0n,
      reserveNonEtx: 0n,
      totalSupply: 0n,
      treasuryLp: 0n,
    });
    expect(etxOut).toBe(0n);
    expect(nonEtxOut).toBe(0n);
  });
});

describe('estimateSwapOut', () => {
  it('matches UniswapV2 0.30% fee formula', () => {
    // amountIn=100, reserveIn=1000, reserveOut=1000
    // out = 1000 * (100 * 997) / (1000 * 1000 + 100 * 997)
    //     = 99700000 / 1099700 = 90.66... → 90
    const out = estimateSwapOut(100n, 1000n, 1000n);
    expect(out).toBe(90n);
  });

  it('returns zero when amountIn is zero', () => {
    expect(estimateSwapOut(0n, 1000n, 1000n)).toBe(0n);
  });
});

describe('buildHarvestPlan', () => {
  it('produces an empty plan when treasury has no LP on either pool', () => {
    const plan = buildHarvestPlan(BASE_CONFIG, [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 0n, 1_000_000n, 500_000n, 10_000n),
      mkSnap('WEGAZ/ETX', WEGAZ_PAIR, WEGAZ, 0n, 1_000_000n, 100_000n, 10_000n),
    ]);
    expect(plan.actions).toHaveLength(0);
    expect(plan.expectedEtxHarvested).toBe(0n);
    expect(plan.skipReason).toMatch(/no treasury LP/);
  });

  it('produces per-pool burn + swap actions and splits ETX 10/10/40/40', () => {
    // 1% burn of treasury LP, no farms wired (falls back to retain).
    const pairs: PairSnapshot[] = [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 1_000n, 10_000n, 5_000n, 10_000n),
      mkSnap('WEGAZ/ETX', WEGAZ_PAIR, WEGAZ, 1_000n, 10_000n, 1_000n, 10_000n),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);

    // Each pool: 1% of 1000 = 10 LP; etxOut=10*10000/10000=10; nonEtxOut=5 (ETI) or 1 (WEGAZ).
    expect(plan.pools[0]!.lpToBurn).toBe(10n);
    expect(plan.pools[0]!.expectedEtxFromBurn).toBe(10n);
    expect(plan.pools[0]!.expectedNonEtxFromBurn).toBe(5n);
    expect(plan.pools[1]!.expectedNonEtxFromBurn).toBe(1n);

    // stETX slice = 10% of expectedEtxHarvested; farms slice routed back to
    // treasury because config.farms === null.
    const harvested = plan.expectedEtxHarvested;
    expect(plan.splits.stakedEtx).toBe((harvested * 1000n) / 10000n);
    expect(plan.splits.farms).toBe((harvested * 1000n) / 10000n);
    expect(plan.splits.polBurn).toBe((harvested * 4000n) / 10000n);
    expect(
      plan.splits.stakedEtx + plan.splits.farms + plan.splits.polBurn + plan.splits.treasury,
    ).toBe(harvested);

    // Distribution actions present (stETX wired, farms falls back to retain).
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).toContain('distribute-to-staked-etx');
    expect(kinds).toContain('retain-in-treasury'); // the farms slice
    // POL burn produces addLiquidity-to-dead per pool with non-zero harvest.
    expect(kinds).toContain('add-liquidity-burn-lp');

    // Retain-in-treasury should cover at least the farms slice AND the
    // treasury slice (two retain-in-treasury actions).
    const retains = plan.actions.filter((a) => a.kind === 'retain-in-treasury');
    expect(retains.length).toBe(2);
  });

  it('routes stETX slice to treasury when stETX is not yet deployed', () => {
    const plan = buildHarvestPlan(
      { ...BASE_CONFIG, stakedEtx: null },
      [mkSnap('ETI/ETX', ETI_PAIR, ETI, 1_000n, 10_000n, 5_000n, 10_000n)],
    );
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).not.toContain('distribute-to-staked-etx');
    const retains = plan.actions.filter((a) => a.kind === 'retain-in-treasury');
    // stETX → retain, farms → retain, treasury slice → retain = 3.
    expect(retains.length).toBe(3);
  });

  it('weights POL slice by ETX-denominated treasury position when weighting=treasury_lp', () => {
    // Pool A: treasury holds 1000 LP of 10000 → 10% of pool → etx-value = 1000.
    // Pool B: treasury holds 2000 LP of 10000 → 20% of pool → etx-value = 4000.
    // Total weight = 5000; POL slice allocation ratio should be 1:4 (A:B).
    // Use 1e18-scaled reserves so integer-division dust is negligible.
    const E18 = 1_000_000_000_000_000_000n;
    const pairs: PairSnapshot[] = [
      mkSnap('A', ETI_PAIR, ETI, 1_000n * E18, 10_000n * E18, 10_000n * E18, 10_000n * E18),
      mkSnap('B', WEGAZ_PAIR, WEGAZ, 2_000n * E18, 20_000n * E18, 10_000n * E18, 10_000n * E18),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);
    expect(plan.polBurnByPool.length).toBe(2);
    const a = plan.polBurnByPool[0]!.etxForPool;
    const b = plan.polBurnByPool[1]!.etxForPool;
    // Ratio ≈ 4.0 to within integer-division dust at 1e18 scale.
    const ratio = Number((b * 10000n) / a) / 10000;
    expect(ratio).toBeGreaterThan(3.99);
    expect(ratio).toBeLessThan(4.01);
  });

  it('weights POL slice equally when weighting=equal', () => {
    const pairs: PairSnapshot[] = [
      mkSnap('A', ETI_PAIR, ETI, 1_000n, 10_000n, 10_000n, 10_000n),
      mkSnap('B', WEGAZ_PAIR, WEGAZ, 2_000n, 20_000n, 10_000n, 10_000n),
    ];
    const plan = buildHarvestPlan(
      { ...BASE_CONFIG, polWeighting: 'equal' },
      pairs,
    );
    const a = plan.polBurnByPool[0]!.etxForPool;
    const b = plan.polBurnByPool[1]!.etxForPool;
    // Last slice gets dust; difference is at most 1 wei.
    const delta = a > b ? a - b : b - a;
    expect(delta).toBeLessThanOrEqual(1n);
  });

  it('applies slippage bps to every quote', () => {
    const plan = buildHarvestPlan(
      { ...BASE_CONFIG, maxSlippageBps: 500 }, // 5%
      [mkSnap('ETI/ETX', ETI_PAIR, ETI, 1_000n, 10_000n, 5_000n, 10_000n)],
    );
    const rm = plan.actions.find((a) => a.kind === 'remove-liquidity');
    expect(rm).toBeDefined();
    if (rm && rm.kind === 'remove-liquidity') {
      // expectedEtxFromBurn=10; minEtxOut = 10 * 9500 / 10000 = 9.
      expect(rm.minEtxOut).toBe(9n);
    }
  });

  it('returns empty plan when burn slice rounds to zero wei', () => {
    const plan = buildHarvestPlan(
      { ...BASE_CONFIG, burnBpsPerRun: 1 }, // 0.01% of 50 LP = 0 wei
      [mkSnap('ETI/ETX', ETI_PAIR, ETI, 50n, 10_000n, 5_000n, 10_000n)],
    );
    expect(plan.actions).toHaveLength(0);
  });
});
