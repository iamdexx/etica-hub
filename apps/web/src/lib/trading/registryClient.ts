import {
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { DEPLOYMENTS, type SupportedChainId } from '@etica-hub/shared';
import { decodeDutchOrder } from '@/lib/trading/dutchOrder';
import type {
  StoredOrderView,
  StrategyType,
  TriggerDirection,
} from '@/lib/trading/orderbookClient';

/**
 * Client wrapper around the on-chain `OrderRegistry` contract.
 *
 * Keepers discover orders by subscribing to the `OrderPosted` event;
 * swappers post orders by calling `postOrder` / `postOrderBatch`. The
 * registry has no owner, no pausing, and no admin surface — once an
 * `orderHash` is written it stays on-chain forever (logically cancelled
 * via `cancelOrder` but never deleted).
 *
 * All struct layouts mirror `packages/trading-contracts/src/OrderRegistry.sol`.
 */

export const REGISTRY_ABI = parseAbi([
  'function postOrder(bytes encodedOrder, bytes signature, (uint8 strategy, uint8 triggerDirection, uint16 indexInBatch, uint16 totalInBatch, bytes32 batchId, uint256 triggerPrice, uint256 levelPrice) meta) returns (bytes32 orderHash)',
  'function postOrderBatch(bytes[] encodedOrders, bytes[] signatures, (uint8 strategy, uint8 triggerDirection, uint16 indexInBatch, uint16 totalInBatch, bytes32 batchId, uint256 triggerPrice, uint256 levelPrice)[] metas) returns (bytes32[])',
  'function cancelOrder(bytes32 orderHash)',
  'function exists(bytes32 orderHash) view returns (bool)',
  'function isCancelled(bytes32 orderHash) view returns (bool)',
  'event OrderPosted(bytes32 indexed orderHash, address indexed poster, uint8 indexed strategy, bytes encodedOrder, bytes signature, (uint8 strategy, uint8 triggerDirection, uint16 indexInBatch, uint16 totalInBatch, bytes32 batchId, uint256 triggerPrice, uint256 levelPrice) meta)',
  'event OrderCancelled(bytes32 indexed orderHash, address indexed poster)',
] as const);

/** Strategy enum values, matching `OrderRegistry.Strategy`. */
export const STRATEGY_LIMIT = 0;
export const STRATEGY_STOP = 1;
export const STRATEGY_DCA = 2;
export const STRATEGY_GRID = 3;

export const TRIGGER_LTE = 0;
export const TRIGGER_GTE = 1;

/**
 * Wire-format `OrderMeta` struct as expected by `postOrder`. All fields are
 * required on-chain; unused fields are set to zero by the builders below.
 */
export interface OrderMetaStruct {
  strategy: number;
  triggerDirection: number;
  indexInBatch: number;
  totalInBatch: number;
  batchId: Hex;
  triggerPrice: bigint;
  levelPrice: bigint;
}

const ZERO_BATCH_ID: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

export function buildLimitMeta(): OrderMetaStruct {
  return {
    strategy: STRATEGY_LIMIT,
    triggerDirection: 0,
    indexInBatch: 0,
    totalInBatch: 1,
    batchId: ZERO_BATCH_ID,
    triggerPrice: 0n,
    levelPrice: 0n,
  };
}

export function buildStopMeta(args: {
  triggerPrice: bigint;
  direction: 'lte' | 'gte';
}): OrderMetaStruct {
  return {
    strategy: STRATEGY_STOP,
    triggerDirection: args.direction === 'lte' ? TRIGGER_LTE : TRIGGER_GTE,
    indexInBatch: 0,
    totalInBatch: 1,
    batchId: ZERO_BATCH_ID,
    triggerPrice: args.triggerPrice,
    levelPrice: 0n,
  };
}

export function buildDcaMeta(args: {
  batchId: Hex;
  indexInBatch: number;
  totalInBatch: number;
}): OrderMetaStruct {
  return {
    strategy: STRATEGY_DCA,
    triggerDirection: 0,
    indexInBatch: args.indexInBatch,
    totalInBatch: args.totalInBatch,
    batchId: args.batchId,
    triggerPrice: 0n,
    levelPrice: 0n,
  };
}

export function buildGridMeta(args: {
  batchId: Hex;
  indexInBatch: number;
  totalInBatch: number;
  levelPrice: bigint;
}): OrderMetaStruct {
  return {
    strategy: STRATEGY_GRID,
    triggerDirection: 0,
    indexInBatch: args.indexInBatch,
    totalInBatch: args.totalInBatch,
    batchId: args.batchId,
    triggerPrice: 0n,
    levelPrice: args.levelPrice,
  };
}

/**
 * Convert a client-generated batch id (hex string or uuid-like) to the bytes32
 * the registry expects. Accepts either a `0x…` 32-byte hex (returned as-is)
 * or a short string that is hashed to produce a stable bytes32.
 */
export function toBatchIdBytes32(raw: string): Hex {
  if (raw.startsWith('0x') && raw.length === 66) return raw as Hex;
  return keccak256(new TextEncoder().encode(raw));
}

/** True when an `OrderRegistry` is deployed on the connected chain. */
export function isRegistryEnabled(chainId: number | undefined): boolean {
  return getRegistryAddress(chainId) !== null;
}

/** Registry address for the given chain, or null when unset / unsupported. */
export function getRegistryAddress(chainId: number | undefined): Address | null {
  if (chainId === undefined) return null;
  const d = DEPLOYMENTS[chainId as SupportedChainId];
  if (!d) return null;
  if (d.orderRegistry === zeroAddress) return null;
  return d.orderRegistry;
}

export interface PostOrderOnChainArgs {
  walletClient: WalletClient;
  publicClient: PublicClient;
  chainId: SupportedChainId;
  account: Address;
  encodedOrder: Hex;
  signature: Hex;
  meta: OrderMetaStruct;
}

export interface PostOrderOnChainResult {
  orderHash: Hex;
  txHash: Hex;
}

/**
 * Submit a signed order to the on-chain registry. Returns the deterministic
 * `orderHash` (= `keccak256(encodedOrder)`) and the posting tx hash. Caller
 * is responsible for waiting on the receipt if they care about confirmation.
 */
export async function postOrderOnChain(args: PostOrderOnChainArgs): Promise<PostOrderOnChainResult> {
  const registry = getRegistryAddress(args.chainId);
  if (!registry) {
    throw new Error(`OrderRegistry not deployed on chain ${args.chainId}`);
  }
  const txHash = await args.walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'postOrder',
    args: [args.encodedOrder, args.signature, args.meta],
    account: args.account,
    chain: args.walletClient.chain,
  });
  return { orderHash: keccak256(args.encodedOrder), txHash };
}

export interface PostOrderBatchOnChainArgs {
  walletClient: WalletClient;
  publicClient: PublicClient;
  chainId: SupportedChainId;
  account: Address;
  encodedOrders: Hex[];
  signatures: Hex[];
  metas: OrderMetaStruct[];
}

export interface PostOrderBatchOnChainResult {
  orderHashes: Hex[];
  txHash: Hex;
}

/**
 * Submit a batch of signed orders in a single tx. Gas-efficient for DCA
 * ladders and grid strategies where the swapper signs N legs up-front.
 */
export async function postOrderBatchOnChain(
  args: PostOrderBatchOnChainArgs,
): Promise<PostOrderBatchOnChainResult> {
  const registry = getRegistryAddress(args.chainId);
  if (!registry) {
    throw new Error(`OrderRegistry not deployed on chain ${args.chainId}`);
  }
  if (
    args.encodedOrders.length !== args.signatures.length ||
    args.encodedOrders.length !== args.metas.length
  ) {
    throw new Error('encodedOrders / signatures / metas must be the same length');
  }
  const txHash = await args.walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'postOrderBatch',
    args: [args.encodedOrders, args.signatures, args.metas],
    account: args.account,
    chain: args.walletClient.chain,
  });
  return {
    orderHashes: args.encodedOrders.map((e) => keccak256(e)),
    txHash,
  };
}

/**
 * Cancel an order on the registry so keepers stop considering it. Does NOT
 * invalidate the permit2 nonce — callers should invalidate via permit2 first
 * when hard-cancelling so the reactor would revert even if a rogue filler
 * tried to submit. `cancelOrder` only sets a registry flag.
 */
export interface CancelOrderOnRegistryArgs {
  walletClient: WalletClient;
  chainId: SupportedChainId;
  account: Address;
  orderHash: Hex;
}

export async function cancelOrderOnRegistry(args: CancelOrderOnRegistryArgs): Promise<Hex> {
  const registry = getRegistryAddress(args.chainId);
  if (!registry) {
    throw new Error(`OrderRegistry not deployed on chain ${args.chainId}`);
  }
  return await args.walletClient.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'cancelOrder',
    args: [args.orderHash],
    account: args.account,
    chain: args.walletClient.chain,
  });
}

/**
 * Fetch open orders for a swapper by reading `OrderPosted` + `OrderCancelled`
 * logs from the registry. Returns rows compatible with `StoredOrderView` so
 * the existing dashboard can render them without rework.
 *
 * `fromBlock` is optional — defaults to `earliest`. On chains with long
 * history, callers should pass the registry's deploy block to keep the log
 * window bounded. Etica mainnet is young enough that a topic-filtered
 * `eth_getLogs` from `0x0` completes in a reasonable time.
 */
export interface FetchRegistryOrdersArgs {
  publicClient: PublicClient;
  chainId: SupportedChainId;
  swapper: Address;
  fromBlock?: bigint;
}

export async function fetchRegistryOrders(
  args: FetchRegistryOrdersArgs,
): Promise<StoredOrderView[]> {
  const registry = getRegistryAddress(args.chainId);
  if (!registry) return [];
  const fromBlock = args.fromBlock ?? 0n;

  const orderPostedEvent = REGISTRY_ABI.find(
    (item) => item.type === 'event' && item.name === 'OrderPosted',
  );
  const orderCancelledEvent = REGISTRY_ABI.find(
    (item) => item.type === 'event' && item.name === 'OrderCancelled',
  );
  if (!orderPostedEvent || !orderCancelledEvent) {
    throw new Error('REGISTRY_ABI is missing OrderPosted / OrderCancelled');
  }

  const postedLogs = await args.publicClient.getLogs({
    address: registry,
    event: orderPostedEvent,
    args: { poster: args.swapper },
    fromBlock,
    toBlock: 'latest',
    strict: true,
  });

  const cancelledLogs = await args.publicClient.getLogs({
    address: registry,
    event: orderCancelledEvent,
    args: { poster: args.swapper },
    fromBlock,
    toBlock: 'latest',
    strict: true,
  });

  const cancelledSet = new Set<Hex>(
    cancelledLogs
      .map((l) => (l.args as { orderHash?: Hex }).orderHash)
      .filter((h): h is Hex => typeof h === 'string'),
  );

  // Resolve block timestamps in parallel (deduped by block number) so
  // `createdAt` / `updatedAt` reflect the actual mining time instead of
  // the block number misinterpreted as a unix timestamp.
  const uniqueBlockNumbers = Array.from(
    new Set(
      postedLogs
        .map((l) => l.blockNumber)
        .filter((b): b is bigint => typeof b === 'bigint'),
    ),
  );
  const blockTimestamps = new Map<bigint, bigint>();
  await Promise.all(
    uniqueBlockNumbers.map(async (bn) => {
      try {
        const block = await args.publicClient.getBlock({ blockNumber: bn });
        blockTimestamps.set(bn, block.timestamp);
      } catch {
        // ignore — we'll fall back to `now` for the affected rows
      }
    }),
  );

  const rows: StoredOrderView[] = [];
  for (const log of postedLogs) {
    const a = log.args as {
      orderHash?: Hex;
      strategy?: number;
      encodedOrder?: Hex;
      signature?: Hex;
      meta?: OrderMetaStruct;
    };
    if (!a.orderHash || !a.encodedOrder || !a.signature || !a.meta) continue;
    let dutch;
    try {
      dutch = decodeDutchOrder(a.encodedOrder);
    } catch {
      continue;
    }
    const primaryOutput = dutch.outputs[0];
    if (!primaryOutput) continue;

    const strategy = a.meta.strategy;
    const strategyType: StrategyType =
      strategy === STRATEGY_STOP
        ? 'stop'
        : strategy === STRATEGY_DCA
          ? 'dca'
          : strategy === STRATEGY_GRID
            ? 'grid'
            : 'limit';

    const triggerDirection: TriggerDirection | null =
      strategyType === 'stop'
        ? a.meta.triggerDirection === TRIGGER_GTE
          ? 'gte'
          : 'lte'
        : null;

    const batchIdStr = a.meta.batchId;
    const hasBatch = batchIdStr !== ZERO_BATCH_ID;

    const cancelled = cancelledSet.has(a.orderHash);
    const expired = Number(dutch.info.deadline) <= Math.floor(Date.now() / 1000);
    const status: StoredOrderView['status'] = cancelled
      ? 'cancelled'
      : expired
        ? 'expired'
        : 'open';

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
        token: primaryOutput.token,
        startAmount: primaryOutput.startAmount.toString(),
        endAmount: primaryOutput.endAmount.toString(),
        recipient: primaryOutput.recipient,
      },
      encodedOrder: a.encodedOrder,
      signature: a.signature,
      status,
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
      createdAt: resolveBlockIso(blockTimestamps, log.blockNumber),
      updatedAt: resolveBlockIso(blockTimestamps, log.blockNumber),
    });
  }

  // Newest first. We prefer on-chain block number for sorting because
  // timestamp resolution can fall back to `now` for un-fetched blocks.
  rows.sort((a, b) => {
    const ca = Date.parse(a.createdAt);
    const cb = Date.parse(b.createdAt);
    return cb - ca;
  });
  return rows;
}

function resolveBlockIso(
  blockTimestamps: Map<bigint, bigint>,
  blockNumber: bigint | null | undefined,
): string {
  if (typeof blockNumber === 'bigint') {
    const ts = blockTimestamps.get(blockNumber);
    if (typeof ts === 'bigint') {
      return new Date(Number(ts) * 1000).toISOString();
    }
  }
  return new Date().toISOString();
}
