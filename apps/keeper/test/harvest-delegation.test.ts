import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { buildHarvestPlan, type PairSnapshot } from '../src/harvest/plan.js';
import { buildDelegationCall } from '../src/harvest/delegation.js';
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
const HARVESTER: Address = '0x2222222222222222222222222222222222222222';

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
  harvester: HARVESTER,
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

describe('buildDelegationCall', () => {
  it('produces one PoolPlan per pair with the planner-derived lp/swap/pol amounts', () => {
    const pairs: PairSnapshot[] = [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 10_000n, 10_000_000n, 5_000_000n, 1_000_000n),
      mkSnap('WEGAZ/ETX', WEGAZ_PAIR, WEGAZ, 30_000n, 10_000_000n, 1_000_000n, 1_000_000n),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);
    const call = buildDelegationCall(BASE_CONFIG, pairs, plan);

    expect(call.pools).toHaveLength(2);
    expect(call.pools[0]!.pair).toBe(ETI_PAIR);
    expect(call.pools[0]!.nonEtx).toBe(ETI);
    expect(call.pools[0]!.lpToBurn).toBe(plan.pools[0]!.lpToBurn);
    expect(call.pools[1]!.pair).toBe(WEGAZ_PAIR);
    expect(call.pools[1]!.nonEtx).toBe(WEGAZ);
    expect(call.pools[1]!.lpToBurn).toBe(plan.pools[1]!.lpToBurn);
  });

  it('applies slippage bps to burn + swap expected amounts', () => {
    const pairs: PairSnapshot[] = [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 10_000n, 10_000_000n, 5_000_000n, 1_000_000n),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);
    const call = buildDelegationCall(BASE_CONFIG, pairs, plan);

    const p = plan.pools[0]!;
    const c = call.pools[0]!;
    const bps = BigInt(10_000 - BASE_CONFIG.maxSlippageBps);
    expect(c.minEtxFromBurn).toBe((p.expectedEtxFromBurn * bps) / 10_000n);
    expect(c.minNonEtxFromBurn).toBe((p.expectedNonEtxFromBurn * bps) / 10_000n);
    expect(c.minEtxFromSwap).toBe((p.expectedEtxFromSwap * bps) / 10_000n);
  });

  it('splits POL ETX into equal halves (rounding remainder to pair leg)', () => {
    const pairs: PairSnapshot[] = [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 10_000n, 10_000_000n, 5_000_000n, 1_000_000n),
      mkSnap('WEGAZ/ETX', WEGAZ_PAIR, WEGAZ, 30_000n, 10_000_000n, 1_000_000n, 1_000_000n),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);
    const call = buildDelegationCall(BASE_CONFIG, pairs, plan);

    for (let i = 0; i < call.pools.length; i++) {
      const c = call.pools[i]!;
      const polForPool = plan.polBurnByPool[i]?.etxForPool ?? 0n;
      expect(c.polEtxForSwap + c.polEtxForPair).toBe(polForPool);
      // Half = floor(x/2); remainder (0 or 1 wei) is carried in polEtxForPair.
      expect(c.polEtxForPair - c.polEtxForSwap === 0n || c.polEtxForPair - c.polEtxForSwap === 1n).toBe(true);
    }
  });

  it('totalPolAssigned never exceeds plan.splits.polBurn (contract invariant)', () => {
    const pairs: PairSnapshot[] = [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 10_000n, 10_000_000n, 5_000_000n, 1_000_000n),
      mkSnap('WEGAZ/ETX', WEGAZ_PAIR, WEGAZ, 30_000n, 10_000_000n, 1_000_000n, 1_000_000n),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);
    const call = buildDelegationCall(BASE_CONFIG, pairs, plan);

    expect(call.totalPolAssigned).toBeLessThanOrEqual(plan.splits.polBurn);
  });

  it('zeroes POL legs when allocation rounds one side to zero (avoid UnevenPolPair revert)', () => {
    // Tiny treasury LP + tiny POL slice → one pool's polForPool rounds to
    // 1 wei, which then splits to 0/1. The builder zeroes both.
    const pairs: PairSnapshot[] = [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 1n, 10_000_000n, 5_000_000n, 1_000_000n),
      mkSnap('WEGAZ/ETX', WEGAZ_PAIR, WEGAZ, 1_000_000n, 10_000_000n, 1_000_000n, 1_000_000n),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);
    const call = buildDelegationCall(BASE_CONFIG, pairs, plan);

    for (const c of call.pools) {
      if (c.polEtxForSwap === 0n || c.polEtxForPair === 0n) {
        expect(c.polEtxForSwap).toBe(0n);
        expect(c.polEtxForPair).toBe(0n);
        expect(c.minNonEtxFromPolSwap).toBe(0n);
      }
    }
  });

  it('returns an empty pools array when given an empty pair list', () => {
    const plan = buildHarvestPlan(BASE_CONFIG, []);
    const call = buildDelegationCall(BASE_CONFIG, [], plan);
    expect(call.pools).toHaveLength(0);
    expect(call.totalPolAssigned).toBe(0n);
  });

  it('skips POL legs for a pool whose LP burn would be zero (treasury LP = 0)', () => {
    const pairs: PairSnapshot[] = [
      mkSnap('ETI/ETX', ETI_PAIR, ETI, 0n, 10_000_000n, 5_000_000n, 1_000_000n),
      mkSnap('WEGAZ/ETX', WEGAZ_PAIR, WEGAZ, 30_000n, 10_000_000n, 1_000_000n, 1_000_000n),
    ];
    const plan = buildHarvestPlan(BASE_CONFIG, pairs);
    const call = buildDelegationCall(BASE_CONFIG, pairs, plan);

    // With no LP on pool 0, there's no POL allocation there.
    expect(plan.polBurnByPool[0]?.etxForPool ?? 0n).toBe(0n);
    expect(call.pools[0]!.lpToBurn).toBe(0n);
    expect(call.pools[0]!.polEtxForSwap).toBe(0n);
    expect(call.pools[0]!.polEtxForPair).toBe(0n);
  });
});
