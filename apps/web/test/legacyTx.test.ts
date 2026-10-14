import { describe, expect, it, vi } from 'vitest';
import { toLegacyTx, withLegacyTxs } from '@/lib/legacyTx';

const node = (chainId: string) =>
  vi.fn(async ({ method }: { method: string; params?: unknown }) => {
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_gasPrice') return '0x746a528800'; // 500 gwei
    if (method === 'eth_estimateGas') return '0x64'; // 100
    if (method === 'eth_sendTransaction') return '0xhash';
    throw new Error(method);
  });

describe('toLegacyTx', () => {
  it('strips 1559 fields and sets type 0, gasPrice and padded gas on Etica', async () => {
    const tx = await toLegacyTx(node('0xf16b'), {
      from: '0xa',
      data: '0x60',
      maxFeePerGas: '0x1',
      maxPriorityFeePerGas: '0x1',
    });
    expect(tx).toEqual({
      from: '0xa',
      data: '0x60',
      type: '0x0',
      gasPrice: '0x746a528800',
      gas: '0x82',
    });
  });

  it('keeps caller-provided gas and gasPrice', async () => {
    const req = node('0xf16b');
    const tx = await toLegacyTx(req, { from: '0xa', gas: '0x10', gasPrice: '0x20' });
    expect(tx).toMatchObject({ gas: '0x10', gasPrice: '0x20', type: '0x0' });
    expect(req).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_estimateGas' }));
  });

  it('leaves non-Etica chains alone', async () => {
    const tx = { from: '0xa', maxFeePerGas: '0x1' };
    expect(await toLegacyTx(node('0x1'), tx)).toBe(tx);
  });

  it('surfaces the estimate error instead of sending', async () => {
    const req = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return '0xf16b';
      if (method === 'eth_gasPrice') return '0x1';
      throw new Error('execution reverted: EDirect: ZERO_ADDRESS');
    });
    await expect(toLegacyTx(req, { from: '0xa' })).rejects.toThrow('EDirect: ZERO_ADDRESS');
  });
});

describe('withLegacyTxs', () => {
  it('rewrites eth_sendTransaction on the provider and is idempotent', async () => {
    const request = node('0xf16b');
    const provider = withLegacyTxs({ request });
    withLegacyTxs(provider);
    await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: '0xa', maxFeePerGas: '0x1' }],
    });
    const sent = request.mock.calls.find(([a]) => a.method === 'eth_sendTransaction')?.[0] as {
      params: unknown[];
    };
    expect(sent.params[0]).toMatchObject({ type: '0x0', gasPrice: '0x746a528800', gas: '0x82' });
    expect(sent.params[0]).not.toHaveProperty('maxFeePerGas');
    expect(request.mock.calls.filter(([a]) => a.method === 'eth_chainId')).toHaveLength(1);
  });
});
