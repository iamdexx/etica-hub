import { describe, expect, it } from 'vitest';
import { observe } from '../src/monitor.js';
import type { Hex, Registration, TwinRecord } from '../src/types.js';
import { makeEticaClient, makeLogger, makeTronClient } from './fakes.js';

const reg: Registration = {
  resTokenId: 1n,
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
    const etica = makeEticaClient({ registrations: [reg] });
    const tron = makeTronClient({
      observation: { mintedByResTokenId: new Map([['1', 7n]]), twins: [twin] },
    });

    const obs = await observe(etica, tron, makeLogger());
    expect(obs.registrations).toEqual([reg]);
    expect(obs.twins).toEqual([twin]);
    expect(obs.mintedByResTokenId.get('1')).toBe(7n);
  });

  it('retries a transient RPC failure rather than aborting the tick', async () => {
    const etica = makeEticaClient({ registrations: [reg] });
    etica.scanRegistrations.mockRejectedValueOnce(new Error('transient')).mockResolvedValue([reg]);

    const obs = await observe(etica, makeTronClient(), makeLogger());
    expect(obs.registrations).toEqual([reg]);
    expect(etica.scanRegistrations).toHaveBeenCalledTimes(2);
  });
});
