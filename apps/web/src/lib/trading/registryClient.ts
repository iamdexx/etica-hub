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
