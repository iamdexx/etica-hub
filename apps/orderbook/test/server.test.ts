import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { createSqliteRepository, type OrderRepository } from '../src/db/index.js';
import { DUTCH_ORDER_ABI_TYPE } from '../src/eip712.js';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const REACTOR = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const SWAPPER = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const TOKEN_IN = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const TOKEN_OUT = '0x4444444444444444444444444444444444444444' as `0x${string}`;
const OTHER_SWAPPER = '0x5555555555555555555555555555555555555555' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const SIG = `0x${'ab'.repeat(65)}` as `0x${string}`;
const FILL_TX = `0x${'cd'.repeat(32)}` as `0x${string}`;
const CANCEL_TX = `0x${'ef'.repeat(32)}` as `0x${string}`;

function encodedOrder(opts?: { swapper?: `0x${string}`; nonce?: bigint }) {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  return encodeAbiParameters(
    [DUTCH_ORDER_ABI_TYPE],
    [
      {
        info: {
          reactor: REACTOR,
          swapper: opts?.swapper ?? SWAPPER,
          nonce: opts?.nonce ?? 1n,
          deadline: nowSec + 3600n,
          additionalValidationContract: ZERO,
          additionalValidationData: '0x' as `0x${string}`,
        },
        decayStartTime: nowSec,
        decayEndTime: nowSec + 60n,
        input: { token: TOKEN_IN, startAmount: 1_000_000n, endAmount: 1_000_000n },
        outputs: [
          { token: TOKEN_OUT, startAmount: 900_000n, endAmount: 800_000n, recipient: opts?.swapper ?? SWAPPER },
        ],
      },
    ],
  );
}

describe('orderbook server', () => {
  let app: FastifyInstance;
  let repo: OrderRepository;

  beforeEach(async () => {
    repo = createSqliteRepository(':memory:');
    app = await buildServer({ repo, keeperAuthToken: 'secret' });
  });

  afterEach(async () => {
    await app.close();
    repo.close();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: 'orderbook' });
  });

  it('POST /orders stores a valid order and returns 201', async () => {
    const encoded = encodedOrder();
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.orderHash).toBe(keccak256(encoded));
    expect(body.swapper.toLowerCase()).toBe(SWAPPER.toLowerCase());
    expect(body.status).toBe('open');
  });

  it('POST /orders rejects duplicate orderHash with 409', async () => {
    const encoded = encodedOrder();
    const first = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('order_already_exists');
  });

  it('POST /orders rejects malformed signature with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encodedOrder(), signature: '0xdead' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /orders filters by swapper', async () => {
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encodedOrder({ nonce: 1n }), signature: SIG },
    });
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encodedOrder({ swapper: OTHER_SWAPPER, nonce: 2n }), signature: SIG },
    });

    const mine = await app.inject({ method: 'GET', url: `/orders?swapper=${SWAPPER}` });
    expect(mine.statusCode).toBe(200);
    const body = mine.json();
    expect(body.count).toBe(1);
    expect(body.orders[0].swapper.toLowerCase()).toBe(SWAPPER.toLowerCase());
  });

  it('GET /orders/:hash returns a stored order', async () => {
    const encoded = encodedOrder();
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    const hash = keccak256(encoded);

    const res = await app.inject({ method: 'GET', url: `/orders/${hash}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().orderHash).toBe(hash);
  });

  it('GET /orders/:hash returns 404 for missing order', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/orders/0x${'de'.repeat(32)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /orders/:hash/cancel marks an open order cancelled', async () => {
    const encoded = encodedOrder();
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    const hash = keccak256(encoded);

    const res = await app.inject({
      method: 'POST',
      url: `/orders/${hash}/cancel`,
      payload: { cancelTxHash: CANCEL_TX },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect(res.json().cancelTxHash).toBe(CANCEL_TX);
  });

  it('POST /orders/:hash/cancel on a filled order returns 409', async () => {
    const encoded = encodedOrder();
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    const hash = keccak256(encoded);

    // Mark filled first (using keeper auth).
    await app.inject({
      method: 'POST',
      url: `/orders/${hash}/mark-filled`,
      headers: { 'x-keeper-auth': 'secret' },
      payload: { fillTxHash: FILL_TX, fillBlockNumber: 1_234_567 },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/orders/${hash}/cancel`,
      payload: { cancelTxHash: CANCEL_TX },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /orders stores a stop order with trigger metadata', async () => {
    const encoded = encodedOrder();
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encoded,
        signature: SIG,
        strategyType: 'stop',
        triggerPrice: '1500000000000000000',
        triggerDirection: 'lte',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.strategyType).toBe('stop');
    expect(body.triggerPrice).toBe('1500000000000000000');
    expect(body.triggerDirection).toBe('lte');
  });

  it('POST /orders defaults strategyType to limit when omitted', async () => {
    const encoded = encodedOrder();
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.strategyType).toBe('limit');
    expect(body.triggerPrice).toBeNull();
    expect(body.triggerDirection).toBeNull();
  });

  it('POST /orders rejects stop without triggerPrice (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder(),
        signature: SIG,
        strategyType: 'stop',
        triggerDirection: 'lte',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /orders rejects stop without triggerDirection (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder(),
        signature: SIG,
        strategyType: 'stop',
        triggerPrice: '1000000000000000000',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /orders rejects limit order carrying a triggerPrice (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder(),
        signature: SIG,
        triggerPrice: '1000000000000000000',
        triggerDirection: 'lte',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /orders rejects non-decimal triggerPrice (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder(),
        signature: SIG,
        strategyType: 'stop',
        triggerPrice: '0xdeadbeef',
        triggerDirection: 'gte',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /orders?strategyType=stop filters to stop orders only', async () => {
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encodedOrder({ nonce: 1n }), signature: SIG },
    });
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder({ nonce: 2n }),
        signature: SIG,
        strategyType: 'stop',
        triggerPrice: '2000000000000000000',
        triggerDirection: 'gte',
      },
    });

    const stops = await app.inject({ method: 'GET', url: '/orders?strategyType=stop' });
    expect(stops.statusCode).toBe(200);
    const body = stops.json();
    expect(body.count).toBe(1);
    expect(body.orders[0].strategyType).toBe('stop');

    const limits = await app.inject({ method: 'GET', url: '/orders?strategyType=limit' });
    expect(limits.json().count).toBe(1);
    expect(limits.json().orders[0].strategyType).toBe('limit');
  });

  it('POST /orders stores a dca leg with batch metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder({ nonce: 10n }),
        signature: SIG,
        strategyType: 'dca',
        dcaBatchId: 'deadbeef-1234-5678-90ab-cdef01234567',
        dcaIndex: 0,
        dcaTotal: 5,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.strategyType).toBe('dca');
    expect(body.dcaBatchId).toBe('deadbeef-1234-5678-90ab-cdef01234567');
    expect(body.dcaIndex).toBe(0);
    expect(body.dcaTotal).toBe(5);
  });

  it('POST /orders rejects dca without dcaBatchId (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder(),
        signature: SIG,
        strategyType: 'dca',
        dcaIndex: 0,
        dcaTotal: 5,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /orders rejects dca with dcaIndex >= dcaTotal (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder(),
        signature: SIG,
        strategyType: 'dca',
        dcaBatchId: 'deadbeef-1234-5678-90ab-cdef01234567',
        dcaIndex: 5,
        dcaTotal: 5,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /orders rejects non-dca order carrying dcaBatchId (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        encodedOrder: encodedOrder(),
        signature: SIG,
        dcaBatchId: 'deadbeef-1234-5678-90ab-cdef01234567',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /orders?dcaBatchId=... returns every leg of one batch', async () => {
    const batchId = 'deadbeef-1234-5678-90ab-cdef01234567';
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/orders',
        payload: {
          encodedOrder: encodedOrder({ nonce: BigInt(100 + i) }),
          signature: SIG,
          strategyType: 'dca',
          dcaBatchId: batchId,
          dcaIndex: i,
          dcaTotal: 3,
        },
      });
    }
    // One unrelated limit order that must not leak into the batch query.
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encodedOrder({ nonce: 999n }), signature: SIG },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/orders?dcaBatchId=${batchId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(3);
    for (const o of body.orders) {
      expect(o.strategyType).toBe('dca');
      expect(o.dcaBatchId).toBe(batchId);
    }
  });

  it('POST /orders/:hash/mark-filled requires keeper auth', async () => {
    const encoded = encodedOrder();
    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { encodedOrder: encoded, signature: SIG },
    });
    const hash = keccak256(encoded);

    const noAuth = await app.inject({
      method: 'POST',
      url: `/orders/${hash}/mark-filled`,
      payload: { fillTxHash: FILL_TX, fillBlockNumber: 1 },
    });
    expect(noAuth.statusCode).toBe(401);

    const withAuth = await app.inject({
      method: 'POST',
      url: `/orders/${hash}/mark-filled`,
      headers: { 'x-keeper-auth': 'secret' },
      payload: { fillTxHash: FILL_TX, fillBlockNumber: 1 },
    });
    expect(withAuth.statusCode).toBe(200);
    expect(withAuth.json().status).toBe('filled');
    expect(withAuth.json().fillTxHash).toBe(FILL_TX);
    expect(withAuth.json().fillBlockNumber).toBe(1);
  });
});
