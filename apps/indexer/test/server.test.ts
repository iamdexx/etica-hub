import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openPriceDb, type PriceDb } from '../src/prices/db';
import { buildPriceServer } from '../src/prices/server';
import type { FastifyInstance } from 'fastify';

describe('price server', () => {
  let db: PriceDb;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openPriceDb(':memory:');
    app = await buildPriceServer({
      db,
      pairIds: ['ETI-ETX', 'EGAZ-ETX'],
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /prices/pairs lists tracked pair ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/prices/pairs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pairs: ['ETI-ETX', 'EGAZ-ETX'] });
  });

  it('GET /prices/:pairId/latest returns 404 for unknown pair', async () => {
    const res = await app.inject({ method: 'GET', url: '/prices/UNKNOWN/latest' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /prices/:pairId/latest returns 404 before any price is written', async () => {
    const res = await app.inject({ method: 'GET', url: '/prices/ETI-ETX/latest' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /prices/:pairId/latest returns the stored row', async () => {
    db.setLatestPrice({
      pairId: 'ETI-ETX',
      baseToken: '0x1111111111111111111111111111111111111111',
      quoteToken: '0x2222222222222222222222222222222222222222',
      priceBasePerQuote: '100',
      priceQuotePerBase: '500',
      ts: 1_700_000_000,
      blockNumber: 100,
    });
    const res = await app.inject({ method: 'GET', url: '/prices/ETI-ETX/latest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pairId: 'ETI-ETX',
      priceQuotePerBase: '500',
      blockNumber: 100,
    });
  });

  it('GET /prices/:pairId/candles returns empty list before any swap', async () => {
    const res = await app.inject({ method: 'GET', url: '/prices/ETI-ETX/candles' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pairId: 'ETI-ETX', interval: '1m', candles: [] });
  });

  it('GET /prices/:pairId/candles returns stored candles', async () => {
    db.applySwap('ETI-ETX', 1_700_000_040, '1000', '1', '1000');
    db.applySwap('ETI-ETX', 1_700_000_100, '1100', '1', '1100');
    const res = await app.inject({ method: 'GET', url: '/prices/ETI-ETX/candles?interval=1m' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      candles: Array<{ bucketStart: number; open: string; close: string }>;
    };
    expect(body.candles).toHaveLength(2);
    expect(body.candles[0].bucketStart).toBe(1_700_000_040);
    expect(body.candles[1].bucketStart).toBe(1_700_000_100);
  });

  it('GET /prices/:pairId/candles rejects invalid interval', async () => {
    const res = await app.inject({ method: 'GET', url: '/prices/ETI-ETX/candles?interval=99h' });
    expect(res.statusCode).toBe(400);
  });

  it('GET /prices/:pairId/candles respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      db.applySwap('ETI-ETX', 1_700_000_000 + i * 60, `${1000 + i}`, '1', '1');
    }
    const res = await app.inject({
      method: 'GET',
      url: '/prices/ETI-ETX/candles?interval=1m&limit=3',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { candles: Array<unknown> };
    expect(body.candles).toHaveLength(3);
  });

  it('GET /prices/:pairId/candles returns 404 for unknown pair', async () => {
    const res = await app.inject({ method: 'GET', url: '/prices/UNKNOWN/candles' });
    expect(res.statusCode).toBe(404);
  });
});
