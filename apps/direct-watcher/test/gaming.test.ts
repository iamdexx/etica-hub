import { describe, expect, it } from 'vitest';
import { checkGaming, type SwapRecord, type WindowSnapshot } from '../src/checks.js';

const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;
const W = '0x00000000000000000000000000000000000000c3' as const;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

const base: WindowSnapshot = {
  pair: W,
  token0: A,
  token1: B,
  retired: false,
  lp0: 1n,
  lp1: 1n,
  r0: 1_000_000n,
  r1: 2_000_000n,
  hubPriceNum: 2n,
  hubPriceDen: 1n,
  loose0: 0n,
  loose1: 0n,
  looseEtx: 0n,
  swaps: [],
};
const pre = { r0: 1_000_000n, r1: 2_000_000n };
const swap = (p: Partial<SwapRecord>): SwapRecord => ({
  amount0In: 0n,
  amount1In: 0n,
  amount0Out: 0n,
  amount1Out: 0n,
  sender: A,
  to: A,
  txHash: tx(1),
  blockNumber: 100n,
  pre,
  ...p,
});

describe('checkGaming', () => {
  it('is quiet for a fair-priced one-off trade', () => {
    // 1000 token0 in at spot 2.0 -> 2000 out minus a 3% fee = 1940 (~300 bps impact, at the threshold)
    const w = { ...base, swaps: [swap({ amount0In: 1_000n, amount1Out: 1_940n })] };
    expect(checkGaming(w, 300, 3)).toEqual([]);
  });
  it('flags a fill far below the pre-trade price', () => {
    const w = { ...base, swaps: [swap({ amount0In: 1_000n, amount1Out: 1_500n })] };
    const f = checkGaming(w, 300, 3);
    expect(f.map((x) => `${x.severity}:${x.code}`)).toEqual(['warning:PRICE_IMPACT']);
    expect(f[0]!.message).toContain('2500 bps');
  });
  it('skips the impact check without a pre-trade Sync in range', () => {
    const w = { ...base, swaps: [swap({ amount0In: 1_000n, amount1Out: 1n, pre: undefined })] };
    expect(checkGaming(w, 300, 3)).toEqual([]);
  });
  it('flags same-sender round trips within the block window, and flipping', () => {
    const w = {
      ...base,
      swaps: [
        swap({ amount0In: 10n, amount1Out: 20n, blockNumber: 100n, txHash: tx(1) }),
        swap({ amount1In: 20n, amount0Out: 10n, blockNumber: 101n, txHash: tx(2) }),
        swap({ amount0In: 10n, amount1Out: 20n, blockNumber: 200n, txHash: tx(3) }),
        swap({ amount1In: 20n, amount0Out: 10n, blockNumber: 250n, txHash: tx(4) }),
        swap({ amount0In: 10n, amount1Out: 20n, blockNumber: 300n, txHash: tx(5) }),
        swap({ amount1In: 20n, amount0Out: 10n, blockNumber: 400n, txHash: tx(6), sender: B }),
      ],
    };
    const codes = checkGaming(w, 300, 3).map((x) => `${x.severity}:${x.code}`);
    expect(codes).toEqual(['warning:ROUND_TRIP', 'info:FLIPPING']);
  });
});
