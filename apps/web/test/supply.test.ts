import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { XEGGEX_FROZEN_HOLDER, EXTERNAL_ADDRESSES } from '@etica-hub/shared';
import {
  EGAZ_BLOCK_REWARD_WEI,
  breakdownSupply,
  egazEmittedFloor,
  formatSupply,
  readErc20Supply,
  readNativeSupply,
  toUnits,
} from '../src/lib/supply';

const E18 = 10n ** 18n;

describe('frozen holder registry', () => {
  it('lists the Xeggex wallet frozen by the Themis hardfork on mainnet only', () => {
    expect(EXTERNAL_ADDRESSES[61803].frozenHolders).toEqual([XEGGEX_FROZEN_HOLDER]);
    expect(XEGGEX_FROZEN_HOLDER.address).toBe('0x5CcCcb6d334197c7C4ba94E7873d0ef11381CD4e');
    expect(EXTERNAL_ADDRESSES[61888].frozenHolders).toEqual([]);
  });
});

describe('breakdownSupply', () => {
  it('nets frozen balances out of total', () => {
    // Mainnet figures at the time of writing: 7.308M ETI total, 1.049M at Xeggex.
    const total = 7_308_385n * E18;
    const frozen = 1_049_466n * E18;
    const b = breakdownSupply(total, [{ holder: XEGGEX_FROZEN_HOLDER, balance: frozen }]);
    expect(b.total).toBe(total);
    expect(b.frozen).toBe(frozen);
    expect(b.circulating).toBe(6_258_919n * E18);
  });

  it('never reports negative circulating supply', () => {
    const b = breakdownSupply(10n, [{ holder: XEGGEX_FROZEN_HOLDER, balance: 25n }]);
    expect(b.frozen).toBe(10n);
    expect(b.circulating).toBe(0n);
  });

  it('with no frozen holders circulating equals total', () => {
    const b = breakdownSupply(100n * E18, []);
    expect(b.circulating).toBe(100n * E18);
    expect(b.frozen).toBe(0n);
  });
});

describe('egazEmittedFloor', () => {
  it('is 2 EGAZ per block since genesis', () => {
    expect(EGAZ_BLOCK_REWARD_WEI).toBe(2n * E18);
    expect(egazEmittedFloor(0n)).toBe(0n);
    expect(egazEmittedFloor(10_936_988n)).toBe(21_873_976n * E18);
  });
});

describe('formatSupply / toUnits', () => {
  it('formats compact magnitudes', () => {
    expect(formatSupply(toUnits(7_308_385_659856535277649752n))).toBe('7.31M');
    expect(formatSupply(toUnits(131_244n * E18))).toBe('131.24k');
    expect(formatSupply(toUnits(100_000_000n * E18))).toBe('100.00M');
    expect(formatSupply(1_500_000_000)).toBe('1.50B');
    expect(formatSupply(12.5)).toBe('12.5');
  });

  it('renders dashes for empty or unreadable values', () => {
    expect(formatSupply(0)).toBe('—');
    expect(formatSupply(Number.NaN)).toBe('—');
  });
});

function fakeClient(opts: { totalSupply?: bigint; balanceOf?: bigint; native?: bigint; fail?: boolean }) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (opts.fail) throw new Error('rpc down');
      if (functionName === 'totalSupply') return opts.totalSupply ?? 0n;
      if (functionName === 'balanceOf') return opts.balanceOf ?? 0n;
      throw new Error(`unexpected ${functionName}`);
    },
    getBalance: async () => {
      if (opts.fail) throw new Error('rpc down');
      return opts.native ?? 0n;
    },
  } as unknown as PublicClient;
}

describe('readErc20Supply', () => {
  it('subtracts the frozen holder balance from totalSupply', async () => {
    const client = fakeClient({ totalSupply: 1_000n * E18, balanceOf: 150n * E18 });
    const b = await readErc20Supply(client, XEGGEX_FROZEN_HOLDER.address, [XEGGEX_FROZEN_HOLDER]);
    expect(b.total).toBe(1_000n * E18);
    expect(b.circulating).toBe(850n * E18);
    expect(b.frozenBalances[0]?.holder.label).toBe('Xeggex (frozen)');
  });

  it('degrades to zero instead of throwing when the RPC fails', async () => {
    const b = await readErc20Supply(fakeClient({ fail: true }), XEGGEX_FROZEN_HOLDER.address, [XEGGEX_FROZEN_HOLDER]);
    expect(b.total).toBe(0n);
    expect(b.circulating).toBe(0n);
  });
});

describe('readNativeSupply', () => {
  it('uses the emission floor as total and nets the frozen native balance', async () => {
    const b = await readNativeSupply(fakeClient({ native: 3_663_184n * E18 }), 10_936_988n, [XEGGEX_FROZEN_HOLDER]);
    expect(b.total).toBe(21_873_976n * E18);
    expect(b.frozen).toBe(3_663_184n * E18);
    expect(b.circulating).toBe(18_210_792n * E18);
  });
});
