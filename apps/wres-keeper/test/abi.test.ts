import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAbiItem } from 'viem';
import {
  ETRX_ABI,
  TRX_RESERVE_TRON_ABI,
  WRAPPED_RES_MINER_TRON_ABI,
} from '../src/abi.js';

describe('ABI fragments are valid', () => {
  it('ETRX exposes mint/approve and they encode', () => {
    expect(
      encodeFunctionData({
        abi: ETRX_ABI,
        functionName: 'mint',
        args: ['0x1111111111111111111111111111111111111111', 1n],
      }),
    ).toMatch(/^0x/);
    expect(getAbiItem({ abi: ETRX_ABI, name: 'approve' })).toBeDefined();
  });

  it('WrappedRESMiner (TRON) exposes the read/write surface', () => {
    for (const name of ['mintTwin', 'claimForPayout', 'pendingReward', 'miners', 'totalSupply'] as const) {
      expect(getAbiItem({ abi: WRAPPED_RES_MINER_TRON_ABI, name })).toBeDefined();
    }
    const miners = getAbiItem({ abi: WRAPPED_RES_MINER_TRON_ABI, name: 'miners' });
    // resTokenId @0, payoutWallet @1 — the indices the tron adapter reads.
    const outputs = miners && 'outputs' in miners ? miners.outputs : undefined;
    expect(outputs?.[0]?.name).toBe('resTokenId');
    expect(outputs?.[1]?.name).toBe('payoutWallet');
  });

  it('TrxReserve (TRON) exposes frontUpgrade/topUp/frontableNow', () => {
    for (const name of ['frontUpgrade', 'topUp', 'frontableNow'] as const) {
      expect(getAbiItem({ abi: TRX_RESERVE_TRON_ABI, name })).toBeDefined();
    }
  });
});
