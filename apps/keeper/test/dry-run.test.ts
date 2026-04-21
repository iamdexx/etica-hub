import { describe, expect, it, vi } from 'vitest';
import { runDryRun } from '../src/dry-run.js';

describe('runDryRun', () => {
  it('skips cleanly when neither registry nor orderbook is set', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const out = await runDryRun({} as never, log);
    expect(out.skipped).toBe(true);
    expect(out.fetched).toBe(0);
    expect(out.fillable).toBe(0);
    expect(log.info).toHaveBeenCalled();
    expect(String(log.info.mock.calls[0]![0])).toMatch(/skipping/);
  });

  it('skips when registry address is zero', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const out = await runDryRun(
      {
        KEEPER_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000000',
        KEEPER_RPC_URL: 'http://rpc',
        KEEPER_REACTOR_ADDRESS: '0x1111111111111111111111111111111111111111',
      } as never,
      log,
    );
    expect(out.skipped).toBe(true);
  });
});
