import { describe, expect, it } from 'vitest';
import { checkFactory, checkGuardianKey, checkWindow, nextState, worst, type FactorySnapshot, type WindowSnapshot } from '../src/checks.js';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;

const factory: FactorySnapshot = {
  feeTo: A,
  feeToSetter: B,
  guardian: A,
  metaPairDeployer: B,
  swapsPaused: false,
  pauseExpiresAt: 0,
  minStEtx: 40_000n * 10n ** 18n,
  baseFeeBps: 300,
  tiers: [{ minStEtx: 40_000n * 10n ** 18n, feeBps: 300 }],
  whitelisted: { [A.toLowerCase()]: true },
};

const window: WindowSnapshot = {
  pair: A,
  token0: A,
  token1: B,
  retired: false,
  lp0: 100n,
  lp1: 100n,
  r0: 1_000n,
  r1: 2_000n,
  hubPriceNum: 2n,
  hubPriceDen: 1n,
  loose0: 0n,
  loose1: 0n,
  looseEtx: 0n,
  swaps: [],
};

describe('checkFactory', () => {
  it('is quiet when on-chain matches expected', () => {
    expect(
      checkFactory(factory, {
        feeTo: A,
        feeToSetter: B,
        minStEtx: (40_000n * 10n ** 18n).toString(),
        baseFeeBps: 300,
        tiers: [{ minStEtx: (40_000n * 10n ** 18n).toString(), feeBps: 300 }],
        whitelist: [A],
      }),
    ).toEqual([]);
  });
  it('feeTo / whitelist drift is critical, tiers drift is a warning', () => {
    const f = checkFactory(factory, { feeTo: B, tiers: [], whitelist: [B] });
    expect(f.map((x) => `${x.severity}:${x.code}`).sort()).toEqual([
      'critical:FEE_TO',
      'critical:WHITELIST',
      'critical:WHITELIST_EXTRA',
      'warning:TIERS',
    ]);
  });
  it('reports a paused venue every run', () => {
    expect(checkFactory({ ...factory, swapsPaused: true }, { whitelist: [A] }).map((f) => f.code)).toEqual(['PAUSED']);
  });
});

describe('checkWindow', () => {
  it('hub LP going down is critical; equal or higher is fine', () => {
    expect(checkWindow(window, { lp0: '100', lp1: '100' }, 100, 500)).toEqual([]);
    expect(checkWindow(window, { lp0: '100', lp1: '101' }, 100, 500)[0]).toMatchObject({
      severity: 'critical',
      code: 'LP_DECREASED',
    });
  });
  it('reported price off the hub cross price is a warning', () => {
    expect(checkWindow({ ...window, r1: 2_030n }, undefined, 100, 500)[0]).toMatchObject({ code: 'RESERVE_DRIFT' });
    expect(checkWindow({ ...window, r1: 2_010n }, undefined, 100, 500)).toEqual([]);
  });
  it('large swaps and loose tokens are info', () => {
    const f = checkWindow(
      { ...window, loose0: 1n, swaps: [{ amount0In: 100n, amount1In: 0n, sender: A, txHash: '0x01' }] },
      undefined,
      100,
      500,
    );
    expect(f.map((x) => `${x.severity}:${x.code}`).sort()).toEqual(['info:LARGE_SWAP', 'info:LOOSE_TOKENS']);
    expect(worst(f)).toBe('info');
  });
});

describe('nextState', () => {
  it('keeps the LP floor when a window reports less', () => {
    const s = nextState([{ ...window, lp0: 50n }], { lastBlock: '1', windows: { [A]: { lp0: '100', lp1: '100' } } }, 9n);
    expect(s).toEqual({ lastBlock: '9', windows: { [A]: { lp0: '100', lp1: '100' } } });
  });
});

describe('checkGuardianKey', () => {
  it('is quiet without a key or when the key is the guardian', () => {
    expect(checkGuardianKey(factory, undefined)).toEqual([]);
    expect(checkGuardianKey(factory, A.toUpperCase() as typeof A)).toEqual([]);
  });
  it('warns when the pause key is no longer the on-chain guardian', () => {
    const [f] = checkGuardianKey(factory, B);
    expect(f.severity).toBe('warning');
    expect(f.code).toBe('GUARDIAN_KEY');
  });
});
