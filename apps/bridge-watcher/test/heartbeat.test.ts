import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readContract = vi.fn();
const writeContract = vi.fn();
const waitForTransactionReceipt = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract, waitForTransactionReceipt }),
    createWalletClient: () => ({ writeContract }),
  };
});

import { privateKeyToAccount } from 'viem/accounts';
import { runHeartbeat } from '../src/heartbeat.js';

const KEY = `0x${'ab'.repeat(32)}` as const;
const SIGNER = privateKeyToAccount(KEY).address;
const MINTER = '0x2222222222222222222222222222222222222222';
const TX = `0x${'11'.repeat(32)}` as const;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let fetchMock: ReturnType<typeof vi.fn>;

const baseEnv = {
  BRIDGE_MINTER_ETH_ADDRESS: MINTER,
  BRIDGE_HEARTBEAT_PRIVATE_KEY: KEY,
  BRIDGE_TELEGRAM_BOT_TOKEN: 'tok',
  BRIDGE_TELEGRAM_CHAT_ID: 'chat',
};

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('runHeartbeat', () => {
  it('does nothing when no remotes are configured', async () => {
    const res = await runHeartbeat({}, log);
    expect(res).toEqual({ results: [], failures: 0 });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('skips remotes when the heartbeat key is unset', async () => {
    const res = await runHeartbeat({ BRIDGE_MINTER_ETH_ADDRESS: MINTER }, log);
    expect(res.failures).toBe(0);
    expect(res.results).toEqual([{ remote: 'Ethereum', skipped: true }]);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('sends heartbeat when the on-chain signer matches', async () => {
    readContract.mockResolvedValue(SIGNER.toLowerCase());
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    const res = await runHeartbeat(baseEnv, log);

    expect(res.failures).toBe(0);
    expect(res.results[0]).toEqual({ remote: 'Ethereum', skipped: false, txHash: TX });
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: MINTER, functionName: 'heartbeat' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to send and alerts on signer mismatch', async () => {
    readContract.mockResolvedValue('0x3333333333333333333333333333333333333333');

    const res = await runHeartbeat(baseEnv, log);

    expect(res.failures).toBe(1);
    expect(res.results[0].error).toBe('signer-mismatch');
    expect(writeContract).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.text).toContain('Bridge heartbeat failed');
    expect(body.text).toContain('signer-mismatch');
  });

  it('flags reverted transactions as failures', async () => {
    readContract.mockResolvedValue(SIGNER);
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });

    const res = await runHeartbeat(baseEnv, log);

    expect(res.failures).toBe(1);
    expect(res.results[0]).toMatchObject({ txHash: TX, error: `tx reverted (${TX})` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('continues to the next remote after an RPC error and alerts once', async () => {
    readContract.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValueOnce(SIGNER);
    writeContract.mockResolvedValue(TX);
    waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    const res = await runHeartbeat({ ...baseEnv, BRIDGE_MINTER_BNB_ADDRESS: MINTER }, log);

    expect(res.results.map((r) => r.remote)).toEqual(['Ethereum', 'BNB Chain']);
    expect(res.results[0].error).toBe('rpc down');
    expect(res.results[1]).toEqual({ remote: 'BNB Chain', skipped: false, txHash: TX });
    expect(res.failures).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
