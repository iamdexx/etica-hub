import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  isEmptyPlan,
  planEntries,
  planExits,
  planPayouts,
  splitPayout,
} from '../src/planner.js';
import type { LockRecord, Observation, PendingUnlock, TwinRecord } from '../src/types.js';

const lock = (resTokenId: bigint): LockRecord => ({
  resTokenId,
  owner: '0x1111111111111111111111111111111111111111',
  tronRecipient: '0x2222222222222222222222222222222222222222',
  payoutWallet: '0x3333333333333333333333333333333333333333',
});

const twin = (tokenId: bigint, pendingSun: bigint): TwinRecord => ({
  tokenId,
  resTokenId: tokenId,
  payoutWallet: '0x3333333333333333333333333333333333333333',
  pendingSun,
});

describe('splitPayout', () => {
  it('splits 1% reserve / 99% payout and conserves the total (keeperOps=0)', () => {
    const { reserveTopUpSun, keeperOpsSun, payoutSun } = splitPayout(1_000_000n, 100);
    expect(reserveTopUpSun).toBe(10_000n);
    expect(keeperOpsSun).toBe(0n);
    expect(payoutSun).toBe(990_000n);
    expect(reserveTopUpSun + keeperOpsSun + payoutSun).toBe(1_000_000n);
  });

  it('three-way split: 1% reserve / 1% keeper / 98% payout', () => {
    const { reserveTopUpSun, keeperOpsSun, payoutSun } = splitPayout(1_000_000n, 100, 100);
    expect(reserveTopUpSun).toBe(10_000n);
    expect(keeperOpsSun).toBe(10_000n);
    expect(payoutSun).toBe(980_000n);
    expect(reserveTopUpSun + keeperOpsSun + payoutSun).toBe(1_000_000n);
  });

  it('floors both slices so no dust is lost (remainder to holder)', () => {
    const { reserveTopUpSun, keeperOpsSun, payoutSun } = splitPayout(999n, 100, 100);
    expect(reserveTopUpSun).toBe(9n);
    expect(keeperOpsSun).toBe(9n);
    expect(payoutSun).toBe(981n);
    expect(reserveTopUpSun + keeperOpsSun + payoutSun).toBe(999n);
  });

  it('rejects negative amounts and out-of-range bps', () => {
    expect(() => splitPayout(-1n, 100)).toThrow();
    expect(() => splitPayout(1n, -1)).toThrow();
    expect(() => splitPayout(1n, 10_001)).toThrow();
    expect(() => splitPayout(1n, 100, -1)).toThrow();
    expect(() => splitPayout(1n, 100, 10_001)).toThrow();
  });

  it('rejects when reserve + keeper exceed 100%', () => {
    expect(() => splitPayout(1n, 5_000, 5_001)).toThrow();
  });
});

describe('planEntries', () => {
  it('plans only locks without an existing twin', () => {
    const minted = new Map<string, bigint>([['1', 7n]]);
    const entries = planEntries([lock(1n), lock(2n)], minted, 0n);
    expect(entries.map((e) => e.resTokenId)).toEqual([2n]);
  });

  it('attaches the initial front amount to each entry', () => {
    const entries = planEntries([lock(5n)], new Map(), 250_000n);
    expect(entries[0]?.initialFrontSun).toBe(250_000n);
  });
});

describe('planPayouts', () => {
  it('skips twins below the dust threshold and zero-reward twins', () => {
    const payouts = planPayouts([twin(1n, 0n), twin(2n, 500_000n), twin(3n, 2_000_000n)], 1_000_000n, 100);
    expect(payouts.map((p) => p.tokenId)).toEqual([3n]);
    expect(payouts[0]?.split.reserveTopUpSun).toBe(20_000n);
    expect(payouts[0]?.split.keeperOpsSun).toBe(0n);
  });
});

describe('planExits', () => {
  const pending = (resTokenId: bigint, unlockReadyAt: bigint, active = true): PendingUnlock => ({
    resTokenId,
    unlockReadyAt,
    active,
  });

  it('finalizes only matured, active, un-vetoed requests', () => {
    const exits = planExits(
      [
        pending(1n, 900n), // matured (now=1000)
        pending(2n, 2_000n), // still in challenge window
        pending(3n, 0n), // vetoed / no request
        pending(4n, 500n, false), // inactive
      ],
      1_000n,
    );
    expect(exits.map((e) => e.resTokenId)).toEqual([1n]);
  });

  it('treats readyAt == now as matured (boundary)', () => {
    expect(planExits([pending(1n, 1_000n)], 1_000n)).toHaveLength(1);
  });
});

describe('buildPlan / isEmptyPlan', () => {
  const observation = (over: Partial<Observation> = {}): Observation => ({
    locks: [],
    mintedByResTokenId: new Map(),
    twins: [],
    pendingUnlocks: [],
    nowSec: 1_000n,
    ...over,
  });

  it('is empty when nothing to do', () => {
    const plan = buildPlan(observation(), { initialFrontSun: 0n, minPayoutSun: 1n, reserveTopUpBps: 100, keeperOpsBps: 100 });
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('combines all three legs', () => {
    const plan = buildPlan(
      observation({
        locks: [lock(1n)],
        twins: [twin(9n, 5_000_000n)],
        pendingUnlocks: [{ resTokenId: 4n, unlockReadyAt: 1n, active: true }],
      }),
      { initialFrontSun: 0n, minPayoutSun: 1n, reserveTopUpBps: 100, keeperOpsBps: 100 },
    );
    expect(isEmptyPlan(plan)).toBe(false);
    expect(plan.entries).toHaveLength(1);
    expect(plan.payouts).toHaveLength(1);
    expect(plan.exits).toHaveLength(1);
  });
});
