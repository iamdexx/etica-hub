/**
 * Registry-sourced order feed for the keeper.
 *
 * Reads `OrderPosted` + `OrderCancelled` events from the on-chain
 * `OrderRegistry` contract and normalizes them into the same
 * `OrderbookOrder` shape the HTTP orderbook produces, so the filter +
 * loop in `index.ts` can stay unchanged.
 *
 * The ABI struct and the `DutchOrder` layout mirror the web wrapper at
 * `apps/web/src/lib/trading/registryClient.ts` — kept in sync by hand
 * because the keeper is a separate package with no browser deps.
 */

import {
  createPublicClient,
  decodeAbiParameters,
  http,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { OrderbookOrder } from './orderbook-client.js';

/** Minimal registry ABI — only the events the keeper needs to read. */
export const REGISTRY_EVENTS_ABI = parseAbi([
  'event OrderPosted(bytes32 indexed orderHash, address indexed poster, uint8 indexed strategy, bytes encodedOrder, bytes signature, (uint8 strategy, uint8 triggerDirection, uint16 indexInBatch, uint16 totalInBatch, bytes32 batchId, uint256 triggerPrice, uint256 levelPrice) meta)',
  'event OrderCancelled(bytes32 indexed orderHash, address indexed poster)',
] as const);

export const STRATEGY_LIMIT = 0;
export const STRATEGY_STOP = 1;
export const STRATEGY_DCA = 2;
export const STRATEGY_GRID = 3;

export const TRIGGER_LTE = 0;
export const TRIGGER_GTE = 1;

const ZERO_BATCH_ID: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface OrderMetaStruct {
  strategy: number;
  triggerDirection: number;
  indexInBatch: number;
  totalInBatch: number;
  batchId: Hex;
  triggerPrice: bigint;
  levelPrice: bigint;
}

interface DecodedDutchOrder {
  info: {
    reactor: Address;
    swapper: Address;
    nonce: bigint;
    deadline: bigint;
    additionalValidationContract: Address;
    additionalValidationData: Hex;
  };
  decayStartTime: bigint;
  decayEndTime: bigint;
  input: { token: Address; startAmount: bigint; endAmount: bigint };
  outputs: ReadonlyArray<{
    token: Address;
    startAmount: bigint;
    endAmount: bigint;
    recipient: Address;
  }>;
}

/** Inverse of the reactor's `abi.encode((DutchOrder))`. */
export function decodeDutchOrder(encoded: Hex): DecodedDutchOrder {
  const params = parseAbiParameters([
    'DutchOrder order',
    'struct DutchOrder { OrderInfo info; uint256 decayStartTime; uint256 decayEndTime; DutchInput input; DutchOutput[] outputs; }',
    'struct OrderInfo { address reactor; address swapper; uint256 nonce; uint256 deadline; address additionalValidationContract; bytes additionalValidationData; }',
    'struct DutchInput { address token; uint256 startAmount; uint256 endAmount; }',
    'struct DutchOutput { address token; uint256 startAmount; uint256 endAmount; address recipient; }',
  ]);
  const [o] = decodeAbiParameters(params, encoded);
  return o as unknown as DecodedDutchOrder;
}

export interface FetchRegistryOrdersArgs {
  /** viem public client already bound to the target chain. */
  publicClient: PublicClient;
  /** OrderRegistry address. */
  registry: Address;
  /** First block to scan; defaults to earliest (0n). */
  fromBlock?: bigint;
}

/**
 * Read the current "open" set from the registry:
 *   - fetch all `OrderPosted` logs (filtered by strategy? no — keep generic)
 *   - fetch all `OrderCancelled` logs, build a Set
 *   - emit every posted order whose hash is not cancelled
 *
 * Status is always `'open'` here; the keeper's filter layer handles
 * deadline / decay windows downstream.
 */
export async function fetchRegistryOrders(
  args: FetchRegistryOrdersArgs,
): Promise<OrderbookOrder[]> {
  const fromBlock = args.fromBlock ?? 0n;

  const postedEvent = REGISTRY_EVENTS_ABI.find(
    (item) => item.type === 'event' && item.name === 'OrderPosted',
  );
  const cancelledEvent = REGISTRY_EVENTS_ABI.find(
    (item) => item.type === 'event' && item.name === 'OrderCancelled',
  );
  if (!postedEvent || !cancelledEvent) {
    throw new Error('REGISTRY_EVENTS_ABI is missing OrderPosted / OrderCancelled');
  }

  const [postedLogs, cancelledLogs] = await Promise.all([
    args.publicClient.getLogs({
      address: args.registry,
      event: postedEvent,
      fromBlock,
      toBlock: 'latest',
      strict: true,
    }),
    args.publicClient.getLogs({
      address: args.registry,
      event: cancelledEvent,
      fromBlock,
      toBlock: 'latest',
      strict: true,
    }),
  ]);

  const cancelledSet = new Set<Hex>(
    cancelledLogs
      .map((l) => (l.args as { orderHash?: Hex }).orderHash)
      .filter((h): h is Hex => typeof h === 'string'),
  );

  const rows: OrderbookOrder[] = [];
  for (const log of postedLogs) {
    const a = log.args as {
      orderHash?: Hex;
      strategy?: number;
      encodedOrder?: Hex;
      signature?: Hex;
      meta?: OrderMetaStruct;
    };
    if (!a.orderHash || !a.encodedOrder || !a.signature || !a.meta) continue;
    if (cancelledSet.has(a.orderHash)) continue;

    let dutch: DecodedDutchOrder;
    try {
      dutch = decodeDutchOrder(a.encodedOrder);
    } catch {
      continue;
    }
    const primary = dutch.outputs[0];
    if (!primary) continue;

    const strategy = a.meta.strategy;
    const strategyType: OrderbookOrder['strategyType'] =
      strategy === STRATEGY_STOP
        ? 'stop'
        : strategy === STRATEGY_DCA
          ? 'dca'
          : strategy === STRATEGY_GRID
            ? 'grid'
            : 'limit';

    const triggerDirection: OrderbookOrder['triggerDirection'] =
      strategyType === 'stop'
        ? a.meta.triggerDirection === TRIGGER_GTE
          ? 'gte'
          : 'lte'
        : null;

    const batchIdStr = a.meta.batchId;
    const hasBatch = batchIdStr !== ZERO_BATCH_ID;

    rows.push({
      orderHash: a.orderHash,
      reactor: dutch.info.reactor,
      swapper: dutch.info.swapper,
      nonce: dutch.info.nonce.toString(),
      deadline: Number(dutch.info.deadline),
      decayStartTime: Number(dutch.decayStartTime),
      decayEndTime: Number(dutch.decayEndTime),
      input: {
        token: dutch.input.token,
        startAmount: dutch.input.startAmount.toString(),
        endAmount: dutch.input.endAmount.toString(),
      },
      output: {
        token: primary.token,
        startAmount: primary.startAmount.toString(),
        endAmount: primary.endAmount.toString(),
        recipient: primary.recipient,
      },
      encodedOrder: a.encodedOrder,
      signature: a.signature,
      status: 'open',
      strategyType,
      triggerPrice: strategyType === 'stop' ? a.meta.triggerPrice.toString() : null,
      triggerDirection,
      dcaBatchId: strategyType === 'dca' && hasBatch ? batchIdStr : null,
      dcaIndex: strategyType === 'dca' ? a.meta.indexInBatch : null,
      dcaTotal: strategyType === 'dca' ? a.meta.totalInBatch : null,
      gridBatchId: strategyType === 'grid' && hasBatch ? batchIdStr : null,
      gridIndex: strategyType === 'grid' ? a.meta.indexInBatch : null,
      gridTotal: strategyType === 'grid' ? a.meta.totalInBatch : null,
      gridLevelPrice: strategyType === 'grid' ? a.meta.levelPrice.toString() : null,
      fillTxHash: null,
      fillBlockNumber: null,
      cancelTxHash: null,
      createdAt: '',
      updatedAt: '',
    });
  }

  return rows;
}

/** Build a viem public client for the keeper's configured RPC. */
export function createKeeperPublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
}
