import { describe, expect, it } from 'vitest';
import { planScanWindow } from '../src/lib/buybot/scan';

describe('planScanWindow', () => {
  const config = { maxBlocksPerRun: 1000 };

  it('returns a lookback window when no cursor exists', () => {
    const w = planScanWindow(500n, null, config, 50n);
    expect(w.fromBlock).toBe(450n);
    expect(w.toBlock).toBe(500n);
  });

  it('clamps the lookback when latest block is smaller than lookback', () => {
    const w = planScanWindow(10n, null, config, 50n);
    expect(w.fromBlock).toBe(0n);
    expect(w.toBlock).toBe(10n);
  });

  it('scans the delta since the last cursor when newer blocks exist', () => {
    const w = planScanWindow(1000n, 995n, config);
    expect(w.fromBlock).toBe(996n);
    expect(w.toBlock).toBe(1000n);
  });

  it('caps the window at maxBlocksPerRun to protect the RPC on catch-up', () => {
    const w = planScanWindow(100_000n, 50_000n, { maxBlocksPerRun: 2_000 });
    expect(w.fromBlock).toBe(50_001n);
    expect(w.toBlock).toBe(52_000n);
    expect(w.toBlock - w.fromBlock + 1n).toBe(2_000n);
  });

  it('falls back to lookback if cursor is ahead of chain (e.g. chain reorg)', () => {
    const w = planScanWindow(100n, 500n, config, 20n);
    expect(w.fromBlock).toBe(80n);
    expect(w.toBlock).toBe(100n);
  });
});
