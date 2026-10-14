import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';

import { loadDirectHarvestConfig } from '../src/direct-harvest/config.js';
import { buildDirectHarvestPlan, withSlippage } from '../src/direct-harvest/plan.js';
import { capGasPrice } from '../src/direct-harvest/run.js';

const ETX = '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044' as Address;
const USDCE = '0x0BA5C0BFd034639330d2CF9DBAD354d8DBc2d335' as Address;
const WEGAZ = '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a' as Address;
const ETI = '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as Address;
const W0 = '0xbAE218bB3CBB62CD8e4f19fD9850c7341DB9e613' as Address;
const W1 = '0x1eE9f4b6636eA20b9231CbeBe3ef8115D91Aa6b3' as Address;

const windows = [
  { pair: W0, token0: USDCE, token1: WEGAZ },
  { pair: W1, token0: USDCE, token1: ETI },
];
const base = {
  windows,
  etx: ETX,
  looseEtx: 0n,
  treasuryBps: 4000,
  treasuryToken: USDCE,
  treasuryPool: { etx: 1_000_000n * 10n ** 18n, treasuryToken: 50_000n * 10n ** 6n },
  maxSlippageBps: 300,
  minEtxWei: 10n ** 18n,
};

describe('loadDirectHarvestConfig', () => {
  it('defaults to the live venue and the hub router', () => {
    const cfg = loadDirectHarvestConfig({});
    expect(cfg.factory).toBe('0x79Fe1715387Cd90541C6e1997185A6f0532F6D90');
    expect(cfg.harvester).toBe('0x5bf07FcE67B52612aBB27DB2AaD6531a542C32C2');
    expect(cfg.hubRouter).toBe('0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723');
    expect(cfg.minEtxWei).toBe(10n ** 18n);
    expect(cfg.dryRun).toBe(false);
  });
  it('rejects a malformed key', () => {
    expect(() => loadDirectHarvestConfig({ HARVEST_PRIVATE_KEY: '0xabc' })).toThrow();
  });
});

describe('buildDirectHarvestPlan', () => {
  it('skips when the adapter holds nothing', () => {
    const plan = buildDirectHarvestPlan({
      ...base,
      quotes: [
        { token: USDCE, amount: 0n, etxOut: 0n },
        { token: WEGAZ, amount: 0n, etxOut: 0n },
        { token: ETI, amount: 0n, etxOut: 0n },
      ],
    });
    expect(plan.plans).toEqual([]);
    expect(plan.skipReason).toMatch(/nothing/);
  });

  it('gives a shared leg its min-out once and lists both windows', () => {
    const plan = buildDirectHarvestPlan({
      ...base,
      quotes: [
        { token: USDCE, amount: 3n * 10n ** 6n, etxOut: 60n * 10n ** 18n },
        { token: WEGAZ, amount: 10n ** 18n, etxOut: 2n * 10n ** 18n },
        { token: ETI, amount: 5n * 10n ** 18n, etxOut: 3n * 10n ** 18n },
      ],
    });
    expect(plan.plans).toHaveLength(2);
    expect(plan.plans[0]!.minEtxOut0).toBe(withSlippage(60n * 10n ** 18n, 300));
    expect(plan.plans[0]!.minEtxOut1).toBe(withSlippage(2n * 10n ** 18n, 300));
    expect(plan.plans[1]!.minEtxOut0).toBe(0n);
    expect(plan.plans[1]!.minEtxOut1).toBe(withSlippage(3n * 10n ** 18n, 300));
    expect(plan.expectedEtx).toBe(65n * 10n ** 18n);
    expect(plan.minTreasuryOut).toBeGreaterThan(0n);
    expect(plan.minTreasuryOut).toBeLessThan(plan.expectedTreasuryOut);
  });

  it('drops a window whose only fee leg the hub cannot price', () => {
    const plan = buildDirectHarvestPlan({
      ...base,
      quotes: [
        { token: USDCE, amount: 0n, etxOut: 0n },
        { token: WEGAZ, amount: 0n, etxOut: 0n },
        { token: ETI, amount: 5n * 10n ** 18n, etxOut: 3n * 10n ** 18n },
      ],
    });
    expect(plan.plans.map((p) => p.pair)).toEqual([W1]);
  });

  it('skips below the dust floor', () => {
    const plan = buildDirectHarvestPlan({
      ...base,
      quotes: [{ token: WEGAZ, amount: 10n ** 15n, etxOut: 10n ** 15n }],
    });
    expect(plan.plans).toEqual([]);
    expect(plan.skipReason).toMatch(/MIN_ETX/);
  });

  it('prices the treasury slice against post-sale reserves (fee sale left more USDC.e in the pool)', () => {
    const quotes = [{ token: USDCE, amount: 1_000n * 10n ** 6n, etxOut: 20_000n * 10n ** 18n }];
    const moved = buildDirectHarvestPlan({ ...base, quotes });
    const still = buildDirectHarvestPlan({ ...base, quotes, treasuryToken: WEGAZ });
    expect(moved.expectedTreasuryOut).toBeGreaterThan(still.expectedTreasuryOut);
  });
});

describe('capGasPrice', () => {
  it('keeps a harvest under the 1 EGAZ node fee cap', () => {
    const gas = 3_000_000n;
    const price = capGasPrice(gas, 500n * 10n ** 9n);
    expect(gas * price).toBeLessThanOrEqual((10n ** 18n * 9n) / 10n);
    expect(capGasPrice(21_000n, 500n * 10n ** 9n)).toBe(500n * 10n ** 9n);
  });
});
