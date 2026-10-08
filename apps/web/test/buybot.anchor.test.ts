import { describe, expect, it } from 'vitest';
import { getAddress, type Address, type PublicClient } from 'viem';
import {
  fetchAnchorEtxUsd,
  resolveUsdPricing,
  MIN_STABLE_ANCHOR_RESERVE,
} from '../src/lib/buybot/scan';

const ETX = getAddress('0xa5A1Bc6307b0b87989B8456D4b35F88a68650044') as Address;
const WEGAZ = getAddress('0x1000000000000000000000000000000000000001') as Address;
const ETI = getAddress('0x2000000000000000000000000000000000000002') as Address;
const USDCE = getAddress('0x3000000000000000000000000000000000000003') as Address;
const FACTORY = getAddress('0x4000000000000000000000000000000000000004') as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

interface Pool {
  pair: Address;
  etxReserve: bigint;
  otherReserve: bigint;
}

/** Fake viem client: ETX is token0 in every pool; decimals: USDC.e 6, rest 18. */
function fakeClient(pools: Partial<Record<'wegaz' | 'eti' | 'usdce', Pool>>): PublicClient {
  const byOther = new Map<string, Pool>();
  if (pools.wegaz) byOther.set(WEGAZ.toLowerCase(), pools.wegaz);
  if (pools.eti) byOther.set(ETI.toLowerCase(), pools.eti);
  if (pools.usdce) byOther.set(USDCE.toLowerCase(), pools.usdce);
  const byPair = new Map([...byOther.values()].map((p) => [p.pair.toLowerCase(), p]));
  const readContract = async (call: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }) => {
    switch (call.functionName) {
      case 'getPair': {
        const other = String(call.args?.[1]).toLowerCase();
        return byOther.get(other)?.pair ?? ZERO;
      }
      case 'token0':
        return ETX;
      case 'getReserves': {
        const p = byPair.get(call.address.toLowerCase());
        if (!p) throw new Error('unknown pair');
        return [p.etxReserve, p.otherReserve, 0] as const;
      }
      case 'decimals':
        return call.address.toLowerCase() === USDCE.toLowerCase() ? 6 : 18;
      default:
        throw new Error(`unexpected ${call.functionName}`);
    }
  };
  return { readContract } as unknown as PublicClient;
}

const base = { factory: FACTORY, etx: ETX, eti: ETI, wegaz: WEGAZ, usdce: USDCE };
const anchors = { etiUsd: 0.0133, egazUsd: 0.00146 };
const wegazPool: Pool = {
  pair: getAddress('0x5000000000000000000000000000000000000005') as Address,
  etxReserve: 9_000_000n * 10n ** 18n,
  otherReserve: 2_750_000n * 10n ** 18n,
};
const usdcePool = (usdce: number): Pool => ({
  pair: getAddress('0x6000000000000000000000000000000000000006') as Address,
  etxReserve: 56_000n * 10n ** 18n,
  otherReserve: BigInt(Math.round(usdce * 1e6)),
});

describe('fetchAnchorEtxUsd', () => {
  it('prices ETX off the USDC.e pool ahead of exchange-anchored pools', async () => {
    const client = fakeClient({ wegaz: wegazPool, usdce: usdcePool(150) });
    const etxUsd = await fetchAnchorEtxUsd(client, { ...base, anchors });
    expect(etxUsd).toBeCloseTo(150 / 56_000, 9);
  });

  it('falls back to ETX/WEGAZ × NonKYC when the USDC.e pool is too shallow', async () => {
    const client = fakeClient({
      wegaz: wegazPool,
      usdce: usdcePool(MIN_STABLE_ANCHOR_RESERVE - 1),
    });
    const etxUsd = await fetchAnchorEtxUsd(client, { ...base, anchors });
    expect(etxUsd).toBeCloseTo((2_750_000 / 9_000_000) * anchors.egazUsd, 12);
  });

  it('falls back to ETX/WEGAZ when the USDC.e pool does not exist', async () => {
    const client = fakeClient({ wegaz: wegazPool });
    const etxUsd = await fetchAnchorEtxUsd(client, { ...base, anchors });
    expect(etxUsd).toBeCloseTo((2_750_000 / 9_000_000) * anchors.egazUsd, 12);
  });

  it('never waits on NonKYC when the USDC.e pool is deep, and derives EGAZ/ETI from their ETX pools', async () => {
    const client = fakeClient({ wegaz: wegazPool, usdce: usdcePool(150) });
    let nonkycCalls = 0;
    const pricing = await resolveUsdPricing(client, base, async () => {
      nonkycCalls += 1;
      throw new Error('nonkyc down');
    });
    expect(nonkycCalls).toBe(0);
    expect(pricing.source).toBe('usdce');
    const etxUsd = 150 / 56_000;
    expect(pricing.etxUsd).toBeCloseTo(etxUsd, 9);
    expect(pricing.egazUsd).toBeCloseTo(etxUsd / (2_750_000 / 9_000_000), 9);
    expect(pricing.etiUsd).toBeNull();
  });

  it('survives a NonKYC failure when it has to fall back (no stable pool)', async () => {
    const client = fakeClient({ wegaz: wegazPool });
    let nonkycCalls = 0;
    const pricing = await resolveUsdPricing(client, base, async () => {
      nonkycCalls += 1;
      throw new Error('nonkyc down');
    });
    expect(nonkycCalls).toBe(1);
    expect(pricing).toEqual({ etxUsd: null, etiUsd: null, egazUsd: null, source: null });
  });

  it('reports NonKYC as the source when the stable pool is shallow', async () => {
    const client = fakeClient({ wegaz: wegazPool, usdce: usdcePool(1) });
    const pricing = await resolveUsdPricing(client, base, async () => anchors);
    expect(pricing.source).toBe('nonkyc');
    expect(pricing.egazUsd).toBe(anchors.egazUsd);
    expect(pricing.etiUsd).toBe(anchors.etiUsd);
  });

  it('returns null with no anchors and no stable pool', async () => {
    const client = fakeClient({ wegaz: wegazPool });
    expect(await fetchAnchorEtxUsd(client, { ...base, usdce: ZERO })).toBeNull();
  });
});
