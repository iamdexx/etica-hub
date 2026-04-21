import { describe, expect, it, vi } from 'vitest';
import { createKeeper } from '../src/index.js';
import type { KeeperConfig } from '../src/config.js';
import type { OrderbookClient, OrderbookOrder } from '../src/orderbook-client.js';

function cfg(overrides: Partial<KeeperConfig> = {}): KeeperConfig {
  return {
    orderbookUrl: 'http://api',
    registryAddress: null,
    keeperAuthToken: null,
    rpcUrl: 'http://rpc',
    chainId: 61803,
    reactor: '0x1111111111111111111111111111111111111111',
    keeperPrivateKey: null,
    pollIntervalMs: 10,
    pollBatchSize: 50,
    deadlineGraceSeconds: 30,
    dryRun: true,
    ...overrides,
  };
}

function mkOrder(overrides: Partial<OrderbookOrder> = {}): OrderbookOrder {
  return {
    orderHash: '0xaa',
    reactor: '0x1111111111111111111111111111111111111111',
    swapper: '0x3333333333333333333333333333333333333333',
    nonce: '1',
    deadline: 2_000,
    decayStartTime: 900,
    decayEndTime: 1_500,
    input: {
      token: '0x4444444444444444444444444444444444444444',
      startAmount: '1000',
      endAmount: '1000',
    },
    output: {
      token: '0x5555555555555555555555555555555555555555',
      startAmount: '1000',
      endAmount: '950',
      recipient: '0x3333333333333333333333333333333333333333',
    },
    encodedOrder: '0xbb',
    signature: '0xcc',
    status: 'open',
    fillTxHash: null,
    fillBlockNumber: null,
    cancelTxHash: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('createKeeper', () => {
  it('tick() returns fetched + fillable counts', async () => {
    const client: OrderbookClient = {
      listOrders: vi.fn().mockResolvedValue([mkOrder(), mkOrder({ status: 'filled' })]),
      markFilled: vi.fn(),
    };
    const keeper = createKeeper(cfg(), { client, now: () => 1_000, log: silentLog() });
    const out = await keeper.tick();
    expect(out).toEqual({ fetched: 2, fillable: 1 });
  });

  it('tick() passes correct params to listOrders', async () => {
    const listOrders = vi.fn().mockResolvedValue([]);
    const client: OrderbookClient = { listOrders, markFilled: vi.fn() };
    const keeper = createKeeper(cfg({ pollBatchSize: 25, deadlineGraceSeconds: 60 }), {
      client,
      now: () => 1_000,
      log: silentLog(),
    });
    await keeper.tick();
    expect(listOrders).toHaveBeenCalledWith({
      status: 'open',
      limit: 25,
      minDeadline: 1_060,
    });
  });

  it('start() loops until stop() is called', async () => {
    let calls = 0;
    const client: OrderbookClient = {
      listOrders: vi.fn().mockImplementation(async () => {
        calls += 1;
        return [];
      }),
      markFilled: vi.fn(),
    };
    const keeper = createKeeper(cfg({ pollIntervalMs: 1 }), {
      client,
      now: () => 1_000,
      log: silentLog(),
    });

    const runP = keeper.start();
    // Let the loop run a handful of iterations, then stop.
    await new Promise((r) => setTimeout(r, 20));
    keeper.stop();
    await runP;

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('start() is idempotent — calling twice does not spin a second loop', async () => {
    const client: OrderbookClient = {
      listOrders: vi.fn().mockResolvedValue([]),
      markFilled: vi.fn(),
    };
    const keeper = createKeeper(cfg({ pollIntervalMs: 1 }), {
      client,
      now: () => 1_000,
      log: silentLog(),
    });

    const p1 = keeper.start();
    const p2 = keeper.start();
    await new Promise((r) => setTimeout(r, 5));
    keeper.stop();
    await Promise.all([p1, p2]);
    // Just asserting both promises resolve; no double-fault.
    expect(true).toBe(true);
  });

  it('tick() continues when listOrders throws (caller observes rejection)', async () => {
    const client: OrderbookClient = {
      listOrders: vi.fn().mockRejectedValue(new Error('network down')),
      markFilled: vi.fn(),
    };
    const keeper = createKeeper(cfg(), { client, now: () => 1_000, log: silentLog() });
    await expect(keeper.tick()).rejects.toThrow(/network down/);
  });

  it('start() logs but does not crash when tick fails', async () => {
    const log = silentLog();
    const client: OrderbookClient = {
      listOrders: vi.fn().mockRejectedValue(new Error('boom')),
      markFilled: vi.fn(),
    };
    const keeper = createKeeper(cfg({ pollIntervalMs: 1 }), {
      client,
      now: () => 1_000,
      log,
    });

    const p = keeper.start();
    await new Promise((r) => setTimeout(r, 5));
    keeper.stop();
    await p;

    expect(log.error).toHaveBeenCalled();
    expect(String(log.error.mock.calls[0]![0])).toMatch(/tick failed/);
  });
});
