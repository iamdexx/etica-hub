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

  it('returns an empty no-op window when the cursor equals the latest block', () => {
    // Chain has not advanced since the previous cron run. Must not re-scan the
    // last N blocks or the bot would repost every buy each minute.
    const w = planScanWindow(1000n, 1000n, config, 50n);
    expect(w.fromBlock).toBe(1001n);
    expect(w.toBlock).toBe(1000n);
    // Caller uses `toBlock < fromBlock` as a no-op signal:
    expect(w.toBlock < w.fromBlock).toBe(true);
  });

  it('returns an empty no-op window when the cursor is ahead of chain (reorg)', () => {
    const w = planScanWindow(100n, 500n, config, 20n);
    expect(w.fromBlock).toBe(101n);
    expect(w.toBlock).toBe(100n);
    expect(w.toBlock < w.fromBlock).toBe(true);
  });
});
