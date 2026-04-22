import { describe, expect, it } from 'vitest';
import type { Block, Transaction } from 'viem';
import { computeBlockStat, formatGwei } from '../src/lib/gas';

type TxWithFees = Transaction & {
  maxPriorityFeePerGas?: bigint | null;
  gasPrice?: bigint | null;
};

function mkTx(fees: {
  maxPriorityFeePerGas?: bigint | null;
  gasPrice?: bigint | null;
}): TxWithFees {
  return {
    ...fees,
    hash: '0x' as unknown as `0x${string}`,
  } as unknown as TxWithFees;
}

function mkBlock(
  override: Partial<Block & { transactions: Transaction[] }> = {},
): Block & { transactions: Transaction[] } {
  return {
    number: 100n,
    timestamp: 1700000000n,
    baseFeePerGas: 1_000_000_000n, // 1 gwei
    gasUsed: 15_000_000n,
    gasLimit: 30_000_000n,
    transactions: [],
    ...override,
  } as unknown as Block & { transactions: Transaction[] };
}

describe('formatGwei', () => {
  it('renders whole gwei with no fractional trailer', () => {
    expect(formatGwei(2_000_000_000n)).toBe('2');
  });

  it('trims trailing zeros on fractional part', () => {
    expect(formatGwei(1_500_000_000n)).toBe('1.5');
  });

  it('renders sub-gwei with six digits of precision', () => {
    expect(formatGwei(123_456n)).toBe('0.000123');
  });

  it('returns em-dash for null / undefined', () => {
    expect(formatGwei(null)).toBe('—');
    expect(formatGwei(undefined)).toBe('—');
  });
});

describe('computeBlockStat', () => {
  it('averages maxPriorityFeePerGas across EIP-1559 txs', () => {
    const b = mkBlock({
      baseFeePerGas: 1_000_000_000n,
      transactions: [
        mkTx({ maxPriorityFeePerGas: 1_000_000_000n }),
        mkTx({ maxPriorityFeePerGas: 3_000_000_000n }),
      ],
    });
    const stat = computeBlockStat(b);
    expect(stat.avgPriorityFeeWei).toBe(2_000_000_000n);
    expect(stat.txCount).toBe(2);
  });

  it('falls back to gasPrice - baseFee for legacy txs', () => {
    const b = mkBlock({
      baseFeePerGas: 1_000_000_000n,
      transactions: [mkTx({ gasPrice: 5_000_000_000n })],
    });
    const stat = computeBlockStat(b);
    expect(stat.avgPriorityFeeWei).toBe(4_000_000_000n);
  });

  it('clamps negative (underpriced) legacy txs at zero', () => {
    const b = mkBlock({
      baseFeePerGas: 5_000_000_000n,
      transactions: [mkTx({ gasPrice: 1_000_000_000n })],
    });
    expect(computeBlockStat(b).avgPriorityFeeWei).toBe(0n);
  });

  it('returns null avgPriorityFee for empty blocks', () => {
    const b = mkBlock({ transactions: [] });
    expect(computeBlockStat(b).avgPriorityFeeWei).toBeNull();
    expect(computeBlockStat(b).txCount).toBe(0);
  });

  it('propagates null baseFee for pre-EIP-1559 blocks', () => {
    const b = mkBlock({
      // @ts-expect-error — viem's Block type always has baseFeePerGas but
      // some legacy nodes omit it; we mirror that in the helper.
      baseFeePerGas: undefined,
      transactions: [],
    });
    expect(computeBlockStat(b).baseFeePerGasWei).toBeNull();
  });

  it('preserves gasUsed / gasLimit / timestamp unchanged', () => {
    const b = mkBlock({
      number: 42n,
      timestamp: 1234567890n,
      gasUsed: 7_000_000n,
      gasLimit: 21_000_000n,
    });
    const stat = computeBlockStat(b);
    expect(stat.number).toBe(42n);
    expect(stat.timestamp).toBe(1234567890n);
    expect(stat.gasUsed).toBe(7_000_000n);
    expect(stat.gasLimit).toBe(21_000_000n);
  });

  it('mixes EIP-1559 and legacy txs in the same block', () => {
    const b = mkBlock({
      baseFeePerGas: 1_000_000_000n,
      transactions: [
        mkTx({ maxPriorityFeePerGas: 2_000_000_000n }),
        mkTx({ gasPrice: 3_000_000_000n }), // effective tip = 2 gwei
      ],
    });
    expect(computeBlockStat(b).avgPriorityFeeWei).toBe(2_000_000_000n);
  });
});
