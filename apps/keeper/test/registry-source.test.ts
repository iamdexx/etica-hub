import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';
import {
  fetchRegistryOrders,
  STRATEGY_DCA,
  STRATEGY_GRID,
  STRATEGY_LIMIT,
  STRATEGY_STOP,
  TRIGGER_GTE,
} from '../src/registry-source.js';

const REACTOR: Address = '0x1111111111111111111111111111111111111111';
const SWAPPER: Address = '0x2222222222222222222222222222222222222222';
const INPUT: Address = '0x3333333333333333333333333333333333333333';
const OUTPUT: Address = '0x4444444444444444444444444444444444444444';
const REGISTRY: Address = '0x5555555555555555555555555555555555555555';
const BATCH_ID: Hex = ('0x' + 'ab'.repeat(32)) as Hex;

interface MetaFixture {
  strategy: number;
  triggerDirection: number;
  indexInBatch: number;
  totalInBatch: number;
  batchId: Hex;
  triggerPrice: bigint;
  levelPrice: bigint;
}

function encodeOrder(overrides: { deadline?: bigint; decayEnd?: bigint } = {}): Hex {
  const params = parseAbiParameters([
    'DutchOrder order',
    'struct DutchOrder { OrderInfo info; uint256 decayStartTime; uint256 decayEndTime; DutchInput input; DutchOutput[] outputs; }',
    'struct OrderInfo { address reactor; address swapper; uint256 nonce; uint256 deadline; address additionalValidationContract; bytes additionalValidationData; }',
    'struct DutchInput { address token; uint256 startAmount; uint256 endAmount; }',
    'struct DutchOutput { address token; uint256 startAmount; uint256 endAmount; address recipient; }',
  ]);
  return encodeAbiParameters(params, [
    {
      info: {
        reactor: REACTOR,
        swapper: SWAPPER,
        nonce: 7n,
        deadline: overrides.deadline ?? 10_000n,
        additionalValidationContract: '0x0000000000000000000000000000000000000000' as Address,
        additionalValidationData: '0x' as Hex,
      },
      decayStartTime: 1_000n,
      decayEndTime: overrides.decayEnd ?? 2_000n,
      input: { token: INPUT, startAmount: 100n, endAmount: 100n },
      outputs: [{ token: OUTPUT, startAmount: 99n, endAmount: 95n, recipient: SWAPPER }],
    },
  ] as never);
}

function postedLog(args: {
  orderHash: Hex;
  strategy: number;
  meta: MetaFixture;
  encoded?: Hex;
  signature?: Hex;
}) {
  return {
    args: {
      orderHash: args.orderHash,
      poster: SWAPPER,
      strategy: args.strategy,
      encodedOrder: args.encoded ?? encodeOrder(),
      signature: args.signature ?? ('0xdeadbeef' as Hex),
      meta: args.meta,
    },
    blockNumber: 1n,
  };
}

function makePublicClient(posted: unknown[], cancelled: unknown[]) {
  return {
    getLogs: vi.fn().mockImplementation(async (opts: { event?: { name?: string } }) => {
      const name = opts.event?.name;
      if (name === 'OrderPosted') return posted;
      if (name === 'OrderCancelled') return cancelled;
      return [];
    }),
  } as never;
}

describe('fetchRegistryOrders', () => {
  it('returns a limit row for strategy=0', async () => {
    const orderHash: Hex = ('0x' + '01'.repeat(32)) as Hex;
    const publicClient = makePublicClient(
      [
        postedLog({
          orderHash,
          strategy: STRATEGY_LIMIT,
          meta: {
            strategy: STRATEGY_LIMIT,
            triggerDirection: 0,
            indexInBatch: 0,
            totalInBatch: 1,
            batchId: ('0x' + '00'.repeat(32)) as Hex,
            triggerPrice: 0n,
            levelPrice: 0n,
          },
        }),
      ],
      [],
    );

    const rows = await fetchRegistryOrders({ publicClient, registry: REGISTRY });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderHash).toBe(orderHash);
    expect(rows[0]!.strategyType).toBe('limit');
    expect(rows[0]!.reactor).toBe(REACTOR);
    expect(rows[0]!.swapper).toBe(SWAPPER);
    expect(rows[0]!.input.token).toBe(INPUT);
    expect(rows[0]!.output.token).toBe(OUTPUT);
    expect(rows[0]!.status).toBe('open');
  });

  it('maps stop strategy with gte trigger', async () => {
    const orderHash: Hex = ('0x' + '02'.repeat(32)) as Hex;
    const publicClient = makePublicClient(
      [
        postedLog({
          orderHash,
          strategy: STRATEGY_STOP,
          meta: {
            strategy: STRATEGY_STOP,
            triggerDirection: TRIGGER_GTE,
            indexInBatch: 0,
            totalInBatch: 1,
            batchId: ('0x' + '00'.repeat(32)) as Hex,
            triggerPrice: 12345n,
            levelPrice: 0n,
          },
        }),
      ],
      [],
    );

    const rows = await fetchRegistryOrders({ publicClient, registry: REGISTRY });
    expect(rows[0]!.strategyType).toBe('stop');
    expect(rows[0]!.triggerDirection).toBe('gte');
    expect(rows[0]!.triggerPrice).toBe('12345');
  });

  it('maps dca strategy with batch metadata', async () => {
    const orderHash: Hex = ('0x' + '03'.repeat(32)) as Hex;
    const publicClient = makePublicClient(
      [
        postedLog({
          orderHash,
          strategy: STRATEGY_DCA,
          meta: {
            strategy: STRATEGY_DCA,
            triggerDirection: 0,
            indexInBatch: 2,
            totalInBatch: 5,
            batchId: BATCH_ID,
            triggerPrice: 0n,
            levelPrice: 0n,
          },
        }),
      ],
      [],
    );

    const rows = await fetchRegistryOrders({ publicClient, registry: REGISTRY });
    expect(rows[0]!.strategyType).toBe('dca');
    expect(rows[0]!.dcaBatchId).toBe(BATCH_ID);
    expect(rows[0]!.dcaIndex).toBe(2);
    expect(rows[0]!.dcaTotal).toBe(5);
  });

  it('maps grid strategy with level price', async () => {
    const orderHash: Hex = ('0x' + '04'.repeat(32)) as Hex;
    const publicClient = makePublicClient(
      [
        postedLog({
          orderHash,
          strategy: STRATEGY_GRID,
          meta: {
            strategy: STRATEGY_GRID,
            triggerDirection: 0,
            indexInBatch: 1,
            totalInBatch: 10,
            batchId: BATCH_ID,
            triggerPrice: 0n,
            levelPrice: 777n,
          },
        }),
      ],
      [],
    );

    const rows = await fetchRegistryOrders({ publicClient, registry: REGISTRY });
    expect(rows[0]!.strategyType).toBe('grid');
    expect(rows[0]!.gridLevelPrice).toBe('777');
    expect(rows[0]!.gridBatchId).toBe(BATCH_ID);
  });

  it('drops cancelled orders', async () => {
    const alive: Hex = ('0x' + '05'.repeat(32)) as Hex;
    const dead: Hex = ('0x' + '06'.repeat(32)) as Hex;
    const publicClient = makePublicClient(
      [
        postedLog({
          orderHash: alive,
          strategy: STRATEGY_LIMIT,
          meta: {
            strategy: STRATEGY_LIMIT,
            triggerDirection: 0,
            indexInBatch: 0,
            totalInBatch: 1,
            batchId: ('0x' + '00'.repeat(32)) as Hex,
            triggerPrice: 0n,
            levelPrice: 0n,
          },
        }),
        postedLog({
          orderHash: dead,
          strategy: STRATEGY_LIMIT,
          meta: {
            strategy: STRATEGY_LIMIT,
            triggerDirection: 0,
            indexInBatch: 0,
            totalInBatch: 1,
            batchId: ('0x' + '00'.repeat(32)) as Hex,
            triggerPrice: 0n,
            levelPrice: 0n,
          },
        }),
      ],
      [{ args: { orderHash: dead, poster: SWAPPER } }],
    );

    const rows = await fetchRegistryOrders({ publicClient, registry: REGISTRY });
    expect(rows.map((r) => r.orderHash)).toEqual([alive]);
  });

  it('propagates fromBlock to getLogs', async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const publicClient = { getLogs } as never;
    await fetchRegistryOrders({ publicClient, registry: REGISTRY, fromBlock: 42n });
    for (const call of getLogs.mock.calls) {
      expect(call[0].fromBlock).toBe(42n);
    }
  });
});
