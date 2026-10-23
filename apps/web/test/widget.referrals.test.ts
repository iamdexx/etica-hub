import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Hex, type PublicClient } from 'viem';
import { DEPLOYMENTS, USDC_WARP_ROUTE, abis, eticaMainnet } from '@etica-hub/shared';
import {
  PROTOCOL_FEE_SHARE,
  REFERRAL_SHARE_OF_PROTOCOL_FEE,
  creditWidgetSwap,
  getReferralTotals,
  memoryReferralStore,
  referralSuffix,
} from '@/lib/widget/referrals';

const d = DEPLOYMENTS[eticaMainnet.id];
const USDC = USDC_WARP_ROUTE.syntheticToken;
const PAIR = '0x55805916c68d85e869F1E9B18957dE7B711C748f' as const;
const FAKE_PAIR = '0x00000000000000000000000000000000000FA4E1' as const;
const HUB_PAIR = '0xa18050ABE8d4b9384fE3b88D3b88eC311e8CcdF8' as const;
const REF = '0x000000000000000000000000000000000000bEEF' as const;
const OTHER_REF = '0x000000000000000000000000000000000000dEaD' as const;
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

function fakeClient(
  logs: ReturnType<typeof swapLog>[],
  opts: { status?: 'success' | 'reverted'; to?: string; input?: Hex } = {},
): PublicClient {
  const tokens: Record<string, { token0: string; token1: string }> = {
    [PAIR.toLowerCase()]: { token0: USDC, token1: d.wegaz },
    // impostor: same tokens, not registered on the factory
    [FAKE_PAIR.toLowerCase()]: { token0: USDC, token1: d.wegaz },
    [HUB_PAIR.toLowerCase()]: { token0: d.etx, token1: d.wegaz },
  };
  const input = opts.input ?? (`0x12345678${'00'.repeat(64)}${referralSuffix(REF).slice(2)}` as Hex);
  return {
    getTransactionReceipt: async () => ({ status: opts.status ?? 'success', logs }),
    getTransaction: async () => ({ to: opts.to ?? d.v2Router, input }),
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
      if (address.toLowerCase() === d.v2Factory.toLowerCase() && functionName === 'getPair') {
        const [a, b] = args as [string, string];
        const set = new Set([a.toLowerCase(), b.toLowerCase()]);
        return set.has(USDC.toLowerCase()) && set.has(d.wegaz.toLowerCase()) ? PAIR : '0x0000000000000000000000000000000000000000';
      }
      const m = tokens[address.toLowerCase()];
      if (!m) throw new Error('unknown pair');
      return m[functionName as 'token0' | 'token1'];
    },
  } as unknown as PublicClient;
}

describe('widget referrals', () => {
  it('credits only registered standalone pairs, in USDC.e terms, once per tx', async () => {
    const store = memoryReferralStore();
    const logs = [
      swapLog(PAIR, [100_000_000n, 0n, 0n, 50_000n * 10n ** 18n]), // 100 USDC.e in
      swapLog(HUB_PAIR, [10n ** 18n, 0n, 0n, 10n ** 18n]), // hub swap in the same tx: ignored
      swapLog(FAKE_PAIR, [10n ** 9n, 0n, 0n, 1n]), // forged Swap from an unregistered contract: ignored
    ];
    const first = await creditWidgetSwap(store, TX, REF, fakeClient(logs));
    expect(first?.status).toBe('credited');
    expect(first?.swaps).toBe(1);
    expect(first?.volumeUsd).toBeCloseTo(100, 6);
    expect(first?.totals?.feesUsd).toBeCloseTo(0.3, 9);
    expect(first?.totals?.commissionUsd).toBeCloseTo(0.3 * PROTOCOL_FEE_SHARE * REFERRAL_SHARE_OF_PROTOCOL_FEE, 9);
    expect(first?.totals?.lastTx).toBe(TX);

    expect((await creditWidgetSwap(store, TX, REF, fakeClient(logs)))?.status).toBe('duplicate');
    const totals = await getReferralTotals(store, REF);
    expect(totals?.swaps).toBe(1);
    expect(totals?.volumeUsd).toBeCloseTo(100, 6);
  });

  it('sums concurrent credits without losing one', async () => {
    const store = memoryReferralStore();
    const mk = (i: number) => fakeClient([swapLog(PAIR, [10_000_000n, 0n, 0n, 1n])]);
    const txs = Array.from({ length: 5 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}` as Hex);
    await Promise.all(txs.map((tx, i) => creditWidgetSwap(store, tx, REF, mk(i))));
    const totals = await getReferralTotals(store, REF);
    expect(totals?.swaps).toBe(5);
    expect(totals?.volumeUsd).toBeCloseTo(50, 6);
  });

  it('refuses hashes that are not a widget swap tagged with this ref', async () => {
    const store = memoryReferralStore();
    const logs = [swapLog(PAIR, [0n, 10n ** 18n, 25_000_000n, 0n])];
    // right tx, wrong claimant: the calldata names REF, not OTHER_REF
    expect((await creditWidgetSwap(store, TX, OTHER_REF, fakeClient(logs)))?.status).toBe('not-widget-tx');
    // untagged swap (sent outside the widget)
    expect((await creditWidgetSwap(store, TX, REF, fakeClient(logs, { input: `0x12345678${'00'.repeat(64)}` as Hex })))?.status).toBe('not-widget-tx');
    // tagged, but not sent to the standalone router
    expect((await creditWidgetSwap(store, TX, REF, fakeClient(logs, { to: d.swapRouter })))?.status).toBe('not-widget-tx');
    // the genuine one still works and uses the USDC.e out leg
    const ok = await creditWidgetSwap(store, TX, REF, fakeClient(logs));
    expect(ok?.status).toBe('credited');
    expect(ok?.volumeUsd).toBeCloseTo(25, 6);
  });

  it('ignores txs without a standalone swap, failed txs and bad input', async () => {
    const store = memoryReferralStore();
    expect((await creditWidgetSwap(store, TX, REF, fakeClient([swapLog(HUB_PAIR, [1n, 0n, 0n, 1n])])))?.status).toBe('no-swap');
    expect((await creditWidgetSwap(store, TX, REF, fakeClient([swapLog(PAIR, [1n, 0n, 0n, 1n])], { status: 'reverted' })))?.status).toBe('failed-tx');
    expect(await creditWidgetSwap(store, 'nope', REF, fakeClient([]))).toBeNull();
    expect(await creditWidgetSwap(store, TX, 'nope', fakeClient([]))).toBeNull();
    expect(await getReferralTotals(store, REF)).toMatchObject({ swaps: 0, volumeUsd: 0 });
  });
});
