import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBrutusClient, type BrutusConfig } from '../src/brutus.js';
import { makeLogger } from './fakes.js';

const CONFIG: BrutusConfig = {
  apiId: 'test-id',
  apiToken: 'test-token',
  baseUrl: 'https://brutus.test',
};

function mockFetch(response: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => response,
  }));
}

describe('BrutusClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('getRates returns all pricing tiers', async () => {
    const rates = {
      energy_minutes_100K: 4.3,
      energy_hour_100K: 4.8,
      energy_one_day_100K: 6.6,
      energy_over_one_day_100K: 13.5,
      band_minutes_1000: 0.6,
      band_hour_1000: 0.7,
      band_one_day_1000: 0.96,
      band_over_one_day_1000: 1.125,
    };
    globalThis.fetch = mockFetch(rates) as unknown as typeof fetch;
    const client = createBrutusClient(CONFIG, makeLogger());

    const result = await client.getRates();
    expect(result.energy_minutes_100K).toBe(4.3);
    expect(result.band_hour_1000).toBe(0.7);
  });

  it('getPrice returns parsed float', async () => {
    globalThis.fetch = mockFetch({ response: 1, price: '2.79' }) as unknown as typeof fetch;
    const client = createBrutusClient(CONFIG, makeLogger());

    const price = await client.getPrice('energy', 32000, '1min');
    expect(price).toBe(2.79);
  });

  it('getPrice throws on error response', async () => {
    globalThis.fetch = mockFetch({ response: 0, msg: 'Invalid amount' }) as unknown as typeof fetch;
    const client = createBrutusClient(CONFIG, makeLogger());

    await expect(client.getPrice('energy', 0, '1min')).rejects.toThrow('Invalid amount');
  });

  it('orderEnergy sends authenticated request', async () => {
    const fetchMock = mockFetch({
      response: 1,
      wallet_buyer: 'TBuyerWallet',
      energy_required: 32000,
      payment: 2.79,
      balance_left: 100,
      tx_id: ['0xabc123'],
      requests_left: 99999,
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    const log = makeLogger();
    const client = createBrutusClient(CONFIG, log);

    const result = await client.orderEnergy('TBuyerWallet', 32000, '5min', 'user-1');
    expect(result.response).toBe(1);
    expect(result.payment).toBe(2.79);
    expect(result.tx_id).toEqual(['0xabc123']);

    const call = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://brutus.test/energy');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['token-api']).toBe('test-token');
    const body = JSON.parse(call[1].body as string);
    expect(body.id_api).toBe('test-id');
    expect(body.wallet).toBe('TBuyerWallet');
    expect(body.amount).toBe(32000);
  });

  it('orderBandwidth sends authenticated request', async () => {
    globalThis.fetch = mockFetch({
      response: 1,
      wallet_buyer: 'TBuyerWallet',
      bandwidth_required: 1000,
      payment: 0.6,
      balance_left: 50,
      tx_id: ['0xdef456'],
      requests_left: 99998,
    }) as unknown as typeof fetch;
    const client = createBrutusClient(CONFIG, makeLogger());

    const result = await client.orderBandwidth('TBuyerWallet', 1000, '5min', 'user-2');
    expect(result.response).toBe(1);
    expect(result.payment).toBe(0.6);
  });

  it('orderEnergy throws on failed order', async () => {
    globalThis.fetch = mockFetch({
      response: 0,
      msg: 'Insufficient balance.',
    }) as unknown as typeof fetch;
    const client = createBrutusClient(CONFIG, makeLogger());

    await expect(
      client.orderEnergy('TBuyerWallet', 32000, '5min', 'user-3'),
    ).rejects.toThrow('Insufficient balance');
  });

  it('getBalance returns account stats', async () => {
    globalThis.fetch = mockFetch({
      msg: 'Verified',
      uses: 20,
      limit: 100000,
      balance: 898.267746,
      pending_to_collect: 12.345678,
      available_balance: 885.922068,
    }) as unknown as typeof fetch;
    const client = createBrutusClient(CONFIG, makeLogger());

    const bal = await client.getBalance();
    expect(bal.balance).toBe(898.267746);
    expect(bal.available_balance).toBe(885.922068);
  });
});
