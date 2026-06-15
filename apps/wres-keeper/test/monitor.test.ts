import { describe, expect, it } from 'vitest';
import { observe } from '../src/monitor.js';
import type { Hex, LockRecord, TwinRecord } from '../src/types.js';
import { makeEticaClient, makeLogger, makeTronClient } from './fakes.js';

const lock: LockRecord = {
  resTokenId: 1n,
  owner: '0x1111111111111111111111111111111111111111',
  tronRecipient: '0x2222222222222222222222222222222222222222' as Hex,
  payoutWallet: '0x3333333333333333333333333333333333333333' as Hex,
};
const twin: TwinRecord = {
  tokenId: 7n,
  resTokenId: 1n,
  payoutWallet: '0x3333333333333333333333333333333333333333' as Hex,
  pendingSun: 2_000_000n,
};

describe('observe', () => {
  it('assembles a single snapshot from both chains', async () => {
    const etica = makeEticaClient({ locks: [lock], nowSec: 1_234n });
    const tron = makeTronClient({
      observation: { mintedByResTokenId: new Map([['1', 7n]]), twins: [twin] },
    });

    const obs = await observe(etica, tron, makeLogger());
    expect(obs.locks).toEqual([lock]);
    expect(obs.twins).toEqual([twin]);
    expect(obs.mintedByResTokenId.get('1')).toBe(7n);
    expect(obs.nowSec).toBe(1_234n);
    expect(obs.pendingUnlocks).toEqual([]);
  });

  it('retries a transient RPC failure rather than aborting the tick', async () => {
    const etica = makeEticaClient({ locks: [lock] });
    etica.scanActiveLocks.mockRejectedValueOnce(new Error('transient')).mockResolvedValue([lock]);

    const obs = await observe(etica, makeTronClient(), makeLogger());
    expect(obs.locks).toEqual([lock]);
    expect(etica.scanActiveLocks).toHaveBeenCalledTimes(2);
  });
});
