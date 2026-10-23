import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Hex, type PublicClient } from 'viem';
import { DEPLOYMENTS, USDC_WARP_ROUTE, abis, eticaMainnet } from '@etica-hub/shared';
import { memoryKv } from '@/lib/buybot/state';
import {
  PROTOCOL_FEE_SHARE,
  REFERRAL_SHARE_OF_PROTOCOL_FEE,
  creditWidgetSwap,
  getReferralTotals,
} from '@/lib/widget/referrals';

const d = DEPLOYMENTS[eticaMainnet.id];
const USDC = USDC_WARP_ROUTE.syntheticToken;
const PAIR = '0x55805916c68d85e869F1E9B18957dE7B711C748f' as const;
const OTHER_PAIR = '0xa18050ABE8d4b9384fE3b88D3b88eC311e8CcdF8' as const;
const REF = '0x000000000000000000000000000000000000bEEF' as const;
const TX = `0x${'ab'.repeat(32)}` as Hex;

function swapLog(pair: `0x${string}`, amounts: [bigint, bigint, bigint, bigint]) {
  const [topic] = encodeEventTopics({ abi: abis.pairAbi, eventName: 'Swap' });
  const sender = `0x${'11'.repeat(32)}` as Hex;
  return {
    address: pair,
    topics: [topic, sender, sender] as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      amounts,
    ),
    blockNumber: 1n,
    transactionHash: TX,
    transactionIndex: 0,
    blockHash: `0x${'22'.repeat(32)}` as Hex,
    logIndex: 0,
    removed: false,
  };
}

function fakeClient(logs: ReturnType<typeof swapLog>[], status: 'success' | 'reverted' = 'success'): PublicClient {
  const meta: Record<string, { factory: string; token0: string; token1: string }> = {
    [PAIR.toLowerCase()]: { factory: d.v2Factory, token0: USDC, token1: d.wegaz },
    [OTHER_PAIR.toLowerCase()]: { factory: d.swapFactory, token0: d.etx, token1: d.wegaz },
  };
  return {
    getTransactionReceipt: async () => ({ status, logs }),
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      const m = meta[address.toLowerCase()];
      if (!m) throw new Error('unknown pair');
      return m[functionName as 'factory' | 'token0' | 'token1'];
    },
  } as unknown as PublicClient;
}

describe('widget referrals', () => {
  it('credits only swaps on standalone-V2 pairs, in USDC.e terms, once per tx', async () => {
    const kv = memoryKv();
    // 100 USDC.e in on our pair (+ a hub swap in the same tx that must not count).
    const logs = [
      swapLog(PAIR, [100_000_000n, 0n, 0n, 50_000n * 10n ** 18n]),
      swapLog(OTHER_PAIR, [10n ** 18n, 0n, 0n, 10n ** 18n]),
    ];
    const first = await creditWidgetSwap(kv, TX, REF, fakeClient(logs));
    expect(first?.status).toBe('credited');
    expect(first?.swaps).toBe(1);
    expect(first?.volumeUsd).toBeCloseTo(100, 6);
    expect(first?.totals?.feesUsd).toBeCloseTo(0.3, 9);
    expect(first?.totals?.commissionUsd).toBeCloseTo(0.3 * PROTOCOL_FEE_SHARE * REFERRAL_SHARE_OF_PROTOCOL_FEE, 9);

    const again = await creditWidgetSwap(kv, TX, REF, fakeClient(logs));
    expect(again?.status).toBe('duplicate');
    const totals = await getReferralTotals(kv, REF);
    expect(totals?.swaps).toBe(1);
    expect(totals?.volumeUsd).toBeCloseTo(100, 6);
  });

  it('uses the USDC.e out leg when selling the spoke token', async () => {
    const kv = memoryKv();
    const res = await creditWidgetSwap(kv, TX, REF, fakeClient([swapLog(PAIR, [0n, 10n ** 18n, 25_000_000n, 0n])]));
    expect(res?.status).toBe('credited');
    expect(res?.volumeUsd).toBeCloseTo(25, 6);
  });

  it('ignores txs without a standalone swap, failed txs and bad input', async () => {
    const kv = memoryKv();
    expect((await creditWidgetSwap(kv, TX, REF, fakeClient([swapLog(OTHER_PAIR, [1n, 0n, 0n, 1n])])))?.status).toBe('no-swap');
    expect((await creditWidgetSwap(kv, TX, REF, fakeClient([swapLog(PAIR, [1n, 0n, 0n, 1n])], 'reverted')))?.status).toBe('failed-tx');
    expect(await creditWidgetSwap(kv, 'nope', REF, fakeClient([]))).toBeNull();
    expect(await creditWidgetSwap(kv, TX, 'nope', fakeClient([]))).toBeNull();
    expect(await getReferralTotals(kv, REF)).toMatchObject({ swaps: 0, volumeUsd: 0 });
  });
});
