import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';

import { loadDirectPulseConfig } from '../src/direct-pulse/config.js';
import { buildPulsePlan, shortestPath, sizeTrip, withSlippage, type PulseWindow } from '../src/direct-pulse/plan.js';

const USDCE = '0x0BA5C0BFd034639330d2CF9DBAD354d8DBc2d335' as Address;
const WEGAZ = '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a' as Address;
const ETI = '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as Address;
const STETX = '0x75d81d03a98CD9195593b8963aF17E13fAa70334' as Address;
const P = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

const NOW = 1_800_000_000;
const DAY = 20 * 3600;
const w = (pair: Address, token0: Address, token1: Address, age: number | null, paused = false): PulseWindow => ({
  pair,
  token0,
  token1,
  lastSwapAt: age === null ? null : NOW - age,
  paused,
});

describe('loadDirectPulseConfig', () => {
  it('defaults to the live venue', () => {
    const cfg = loadDirectPulseConfig({});
    expect(cfg.factory).toBe('0x79Fe1715387Cd90541C6e1997185A6f0532F6D90');
    expect(cfg.router).toBe('0xa3f84D02b96Ab59B75D67c03B3397B682EE1740B');
    expect(cfg.wegaz).toBe(WEGAZ);
    expect(cfg.amountWei).toBe(250n * 10n ** 18n);
    expect(cfg.maxQuietSeconds).toBe(DAY);
  });
  it('rejects a malformed key', () => {
    expect(() => loadDirectPulseConfig({ HARVEST_PRIVATE_KEY: '0xabc' })).toThrow();
  });
});

describe('shortestPath', () => {
  const windows = [w(P(1), USDCE, WEGAZ, null), w(P(2), USDCE, ETI, null), w(P(3), STETX, ETI, null)];
  it('walks across windows', () => {
    expect(shortestPath(windows, WEGAZ, STETX)).toEqual([WEGAZ, USDCE, ETI, STETX]);
  });
  it('ignores paused windows', () => {
    const paused = windows.map((x) => (x.pair === P(2) ? { ...x, paused: true } : x));
    expect(shortestPath(paused, WEGAZ, ETI)).toBeNull();
  });
});

describe('buildPulsePlan', () => {
  it('does nothing when every window traded recently', () => {
    const plan = buildPulsePlan({
      windows: [w(P(1), USDCE, WEGAZ, 3600), w(P(2), USDCE, ETI, 7200)],
      wegaz: WEGAZ,
      now: NOW,
      maxQuietSeconds: DAY,
    });
    expect(plan.trips).toEqual([]);
    expect(plan.quiet).toEqual([]);
  });

  it('round-trips a quiet EGAZ window in and out through itself', () => {
    const plan = buildPulsePlan({
      windows: [w(P(1), USDCE, WEGAZ, DAY + 1), w(P(2), USDCE, ETI, 60)],
      wegaz: WEGAZ,
      now: NOW,
      maxQuietSeconds: DAY,
    });
    expect(plan.trips).toHaveLength(1);
    expect(plan.trips[0].out.path).toEqual([WEGAZ, USDCE]);
    expect(plan.trips[0].back.path).toEqual([USDCE, WEGAZ]);
    expect(plan.trips[0].out.pairs).toEqual([P(1)]);
  });

  it('reaches a window without EGAZ through a neighbour and counts crossed windows as pulsed', () => {
    const windows = [
      w(P(1), USDCE, WEGAZ, null),
      w(P(2), USDCE, ETI, null),
      w(P(3), WEGAZ, ETI, null),
    ];
    const plan = buildPulsePlan({ windows, wegaz: WEGAZ, now: NOW, maxQuietSeconds: DAY });
    // P1 trip: WEGAZ->USDCE, USDCE->WEGAZ. P2 trip enters via USDC.e or ETI and leaves
    // through the other, so P1 or P3 is crossed again; P3 is then already pulsed.
    expect(plan.quiet).toEqual([P(1), P(2), P(3)]);
    const crossed = new Set(plan.trips.flatMap((t) => [...t.out.pairs, ...t.back.pairs]));
    expect(crossed).toEqual(new Set([P(1), P(2), P(3)]));
    expect(plan.trips.length).toBeLessThanOrEqual(2);
    for (const t of plan.trips) {
      expect(t.out.path[0]).toBe(WEGAZ);
      expect(t.back.path[t.back.path.length - 1]).toBe(WEGAZ);
    }
  });

  it('skips paused windows and windows with no route to EGAZ', () => {
    const plan = buildPulsePlan({
      windows: [w(P(1), USDCE, WEGAZ, null, true), w(P(2), STETX, ETI, null)],
      wegaz: WEGAZ,
      now: NOW,
      maxQuietSeconds: DAY,
    });
    expect(plan.trips).toEqual([]);
    expect(plan.skipped).toEqual([
      { pair: P(1), reason: 'paused' },
      { pair: P(2), reason: 'no EGAZ route' },
    ]);
  });
});

describe('withSlippage', () => {
  it('shaves bps', () => {
    expect(withSlippage(10_000n, 300)).toBe(9_700n);
  });

  it('leaves unseeded windows alone and does not route through them', () => {
    const empty = { ...w(P(3), WEGAZ, ETI, null), reserves: [0n, 0n] as const };
    const plan = buildPulsePlan({
      windows: [w(P(1), USDCE, WEGAZ, null), { ...w(P(2), USDCE, ETI, null), reserves: [10n, 10n] as const }, empty],
      wegaz: WEGAZ,
      now: NOW,
      maxQuietSeconds: DAY,
    });
    expect(plan.skipped).toEqual([{ pair: P(3), reason: 'unseeded' }]);
    expect(plan.trips.map((t) => t.target)).toEqual([P(1), P(2)]);
    expect(plan.trips[1].out.path).toEqual([WEGAZ, USDCE, ETI]);
  });

  it('sizes a trip to a slice of the first window EGAZ reserve', () => {
    const windows = [{ ...w(P(1), USDCE, WEGAZ, null), reserves: [10_000_000n, 5_000n * 10n ** 18n] as const }];
    const plan = buildPulsePlan({ windows, wegaz: WEGAZ, now: NOW, maxQuietSeconds: DAY });
    const trip = plan.trips[0];
    expect(sizeTrip({ trip, windows, wegaz: WEGAZ, amountWei: 250n * 10n ** 18n, maxReserveBps: 200 })).toBe(
      100n * 10n ** 18n,
    );
    expect(sizeTrip({ trip, windows, wegaz: WEGAZ, amountWei: 50n * 10n ** 18n, maxReserveBps: 200 })).toBe(
      50n * 10n ** 18n,
    );
    expect(
      sizeTrip({ trip, windows: [w(P(1), USDCE, WEGAZ, null)], wegaz: WEGAZ, amountWei: 7n, maxReserveBps: 200 }),
    ).toBe(7n);
  });
});
