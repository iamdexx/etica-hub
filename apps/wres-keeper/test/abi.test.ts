import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeFunctionData, getAbiItem } from 'viem';
import {
  ETRX_ABI,
  RES_LOCK_VAULT_ABI,
  TRX_RESERVE_TRON_ABI,
  WRAPPED_RES_MINER_TRON_ABI,
} from '../src/abi.js';

describe('ABI fragments are valid', () => {
  it('RESLockVault exposes the events + functions the keeper uses', () => {
    expect(getAbiItem({ abi: RES_LOCK_VAULT_ABI, name: 'Locked' })).toBeDefined();
    expect(getAbiItem({ abi: RES_LOCK_VAULT_ABI, name: 'UnlockRequested' })).toBeDefined();
    expect(getAbiItem({ abi: RES_LOCK_VAULT_ABI, name: 'locks' })).toBeDefined();
    expect(getAbiItem({ abi: RES_LOCK_VAULT_ABI, name: 'executeUnlock' })).toBeDefined();
    // Events are encodable (proves a well-formed ABI).
    expect(encodeEventTopics({ abi: RES_LOCK_VAULT_ABI, eventName: 'Locked' })).toBeTruthy();
  });

  it('locks() decodes to the 6-field struct the adapter destructures', () => {
    const item = getAbiItem({ abi: RES_LOCK_VAULT_ABI, name: 'locks' });
    expect(item && 'outputs' in item ? item.outputs?.length : 0).toBe(6);
  });

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
