import { describe, expect, it, vi } from 'vitest';
import { createOrderbookClient } from '../src/orderbook-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOrderbookClient', () => {
  it('listOrders builds query params + returns orders array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { orders: [{ orderHash: '0xaa' }] }));
    const client = createOrderbookClient({ baseUrl: 'http://api', fetchImpl });

    const out = await client.listOrders({
      status: 'open',
      limit: 10,
      minDeadline: 1234,
      swapper: '0x1111111111111111111111111111111111111111',
    });

    expect(out).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toMatch(/^http:\/\/api\/orders\?/);
    expect(url).toMatch(/status=open/);
    expect(url).toMatch(/limit=10/);
    expect(url).toMatch(/minDeadline=1234/);
    expect(url).toMatch(/swapper=0x1111111111111111111111111111111111111111/);
    expect((init as RequestInit).method).toBe('GET');
  });

  it('listOrders with no params hits the bare endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { orders: [] }));
    const client = createOrderbookClient({ baseUrl: 'http://api/', fetchImpl });
    const out = await client.listOrders();
    expect(out).toEqual([]);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://api/orders');
  });

  it('listOrders throws on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const client = createOrderbookClient({ baseUrl: 'http://api', fetchImpl });
    await expect(client.listOrders()).rejects.toThrow(/500/);
  });

  it('listOrders tolerates missing/empty body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const client = createOrderbookClient({ baseUrl: 'http://api', fetchImpl });
    expect(await client.listOrders()).toEqual([]);
  });

  it('markFilled POSTs body + sets auth header when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = createOrderbookClient({
      baseUrl: 'http://api',
      keeperAuthToken: 'secret',
      fetchImpl,
    });
    await client.markFilled('0xdead', '0xbeef', 123);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://api/orders/0xdead/mark-filled');
    const opts = init as RequestInit;
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['X-Keeper-Auth']).toBe('secret');
    expect((opts.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(opts.body as string)).toEqual({ fillTxHash: '0xbeef', fillBlockNumber: 123 });
  });

  it('markFilled omits auth header when not configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = createOrderbookClient({ baseUrl: 'http://api', fetchImpl });
    await client.markFilled('0xdead', '0xbeef', 123);
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Keeper-Auth']).toBeUndefined();
  });

  it('markFilled throws on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const client = createOrderbookClient({ baseUrl: 'http://api', fetchImpl });
    await expect(client.markFilled('0xdead', '0xbeef', 1)).rejects.toThrow(/401/);
  });
});
