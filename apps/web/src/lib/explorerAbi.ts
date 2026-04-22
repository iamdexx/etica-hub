/**
 * ABI-driven decoder for the /explorer/* pages.
 *
 * Etherscan's biggest UX lever over a plain RPC dump is that it turns
 *   `0xa9059cbb0000…00056bc75e2d63100000`
 * into
 *   `transfer(to: 0x…, value: 100 ETX)`.
 * This module is the minimum version of that: try a handful of known ABIs
 * against unknown calldata / logs and report the first match.
 *
 * Design constraints:
 *   - No indexer, no off-chain registry. The ABI pool is whatever the
 *     protocol already ships via `@etica-hub/shared` plus a couple of
 *     registry ABIs vendored inline.
 *   - Lookup favours the contract address's "primary" ABI first, then
 *     falls back to canonical ERC-20 / ERC-721 / pair decoding so random
 *     third-party tokens decode correctly too.
 *   - Viem owns the real decoding; our job is to (a) present a stable
 *     `{ name, args: [{ name, type, value }] }` shape to the UI and
 *     (b) swallow mismatches silently rather than blowing up the page.
 */
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  parseAbi,
  type Abi,
  type AbiFunction,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
} from '@etica-hub/shared';

const MAINNET_CHAIN_ID = 61803;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * OrderRegistry ABI — duplicated (not imported) because
 * `apps/web/src/lib/trading/registryClient.ts` is a browser module that
 * pulls in wallet-client types. The explorer runs on the server and we
 * want to keep its module graph lean.
 */
const ORDER_REGISTRY_ABI = parseAbi([
  'function postOrder(bytes encodedOrder, bytes signature, (uint8 strategy, uint8 triggerDirection, uint16 indexInBatch, uint16 totalInBatch, bytes32 batchId, uint256 triggerPrice, uint256 levelPrice) meta) returns (bytes32 orderHash)',
  'function postOrderBatch(bytes[] encodedOrders, bytes[] signatures, (uint8 strategy, uint8 triggerDirection, uint16 indexInBatch, uint16 totalInBatch, bytes32 batchId, uint256 triggerPrice, uint256 levelPrice)[] metas) returns (bytes32[])',
  'function cancelOrder(bytes32 orderHash)',
  'function exists(bytes32 orderHash) view returns (bool)',
  'function isCancelled(bytes32 orderHash) view returns (bool)',
  'event OrderPosted(bytes32 indexed orderHash, address indexed poster, uint8 indexed strategy, bytes encodedOrder, bytes signature, (uint8 strategy, uint8 triggerDirection, uint16 indexInBatch, uint16 totalInBatch, bytes32 batchId, uint256 triggerPrice, uint256 levelPrice) meta)',
  'event OrderCancelled(bytes32 indexed orderHash, address indexed poster)',
] as const);

/**
 * Ordered pool of "always try" ABIs. Order matters for overlapping
 * selectors: a pair contract's `transfer` (inherited from ERC-20) and a
 * router's `swapExactTokensForTokens` both live here — we try the
 * address-specific ABI first (see `abisForAddress`) and only fall back to
 * this pool when the caller is unknown.
 */
const COMMON_ABIS: ReadonlyArray<{ name: string; abi: Abi }> = [
  { name: 'ERC20', abi: abis.erc20Abi as Abi },
  { name: 'UniswapV2Pair', abi: abis.pairAbi as Abi },
  { name: 'UniswapV2Router', abi: abis.routerAbi as Abi },
  { name: 'UniswapV2Factory', abi: abis.factoryAbi as Abi },
  { name: 'WEGAZ', abi: abis.wegazAbi as Abi },
  { name: 'Permit2', abi: abis.permit2Abi as Abi },
  { name: 'ResearchSubscription', abi: abis.researchSubscriptionAbi as Abi },
  { name: 'EticaCore', abi: abis.eticaCoreAbi as Abi },
  { name: 'OrderRegistry', abi: ORDER_REGISTRY_ABI as Abi },
];

/**
 * Primary ABI for a specific deployed contract. We try this one first and
 * only fall through to COMMON_ABIS if it fails to decode (e.g. a router
 * call with `delegatecall`-style wrapped selectors we don't model).
 */
function buildAddressAbiMap(): Record<string, { name: string; abi: Abi }> {
  const map: Record<string, { name: string; abi: Abi }> = {};
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (d) {
    const put = (addr: Address | undefined, entry: { name: string; abi: Abi }) => {
      if (addr && addr !== ZERO_ADDRESS) map[addr.toLowerCase()] = entry;
    };
    put(d.etx, { name: 'ERC20', abi: abis.erc20Abi as Abi });
    put(d.wegaz, { name: 'WEGAZ', abi: abis.wegazAbi as Abi });
    put(d.swapFactory, { name: 'UniswapV2Factory', abi: abis.factoryAbi as Abi });
    put(d.swapRouter, { name: 'UniswapV2Router', abi: abis.routerAbi as Abi });
    put(d.researchSubscription, {
      name: 'ResearchSubscription',
      abi: abis.researchSubscriptionAbi as Abi,
    });
    put(d.permit2, { name: 'Permit2', abi: abis.permit2Abi as Abi });
    put(d.orderRegistry, { name: 'OrderRegistry', abi: ORDER_REGISTRY_ABI as Abi });
  }
  if (ext) {
    if (ext.eti && ext.eti !== ZERO_ADDRESS) {
      map[ext.eti.toLowerCase()] = { name: 'ERC20', abi: abis.erc20Abi as Abi };
    }
  }
  return map;
}

const ADDRESS_ABIS = buildAddressAbiMap();

/**
 * Returns the ABIs to try for a given recipient, primary-first. Always
 * includes every COMMON ABI last so even unknown contracts decode basic
 * transfers, approvals, and pair events.
 */
function abisForAddress(address: Address | null | undefined): ReadonlyArray<{
  name: string;
  abi: Abi;
}> {
  const primary = address ? ADDRESS_ABIS[address.toLowerCase()] : undefined;
  return primary ? [primary, ...COMMON_ABIS] : COMMON_ABIS;
}

export interface DecodedArg {
  name: string;
  type: string;
  value: unknown;
}

export interface DecodedCall {
  abiName: string;
  functionName: string;
  args: DecodedArg[];
}

export interface DecodedLog {
  abiName: string;
  eventName: string;
  args: DecodedArg[];
}

function functionInputs(abi: Abi, name: string): readonly AbiFunction['inputs'][number][] {
  for (const item of abi) {
    if (item.type === 'function' && item.name === name) return item.inputs;
  }
  return [];
}

function eventInputs(abi: Abi, name: string): readonly AbiEvent['inputs'][number][] {
  for (const item of abi) {
    if (item.type === 'event' && item.name === name) return item.inputs;
  }
  return [];
}

function zipArgs(
  inputs: readonly { name?: string; type: string }[],
  values: readonly unknown[] | Record<string, unknown> | undefined,
): DecodedArg[] {
  if (values == null) return [];
  // Viem returns named args as an object when every input has a name, and
  // as a positional array otherwise. Accept both shapes.
  const arr: unknown[] = Array.isArray(values)
    ? values
    : inputs.map((inp, i) => (inp.name && inp.name in (values as Record<string, unknown>)
        ? (values as Record<string, unknown>)[inp.name]
        : (values as Record<string | number, unknown>)[i]));
  return inputs.map((inp, i) => ({
    name: inp.name && inp.name.length > 0 ? inp.name : `arg${i}`,
    type: inp.type,
    value: arr[i],
  }));
}

/**
 * Decode a transaction's calldata against the ABIs we know. Returns the
 * first successful decode, or null if nothing matches (e.g. delegatecall
 * proxies, pre-EIP-1967 implementations, unknown tokens).
 */
export function decodeCall(to: Address | null | undefined, input: Hex): DecodedCall | null {
  if (!input || input === '0x' || input.length < 10) return null;
  for (const { name, abi } of abisForAddress(to)) {
    try {
      const decoded = decodeFunctionData({ abi, data: input });
      const inputs = functionInputs(abi, decoded.functionName);
      return {
        abiName: name,
        functionName: decoded.functionName,
        args: zipArgs(inputs, decoded.args as readonly unknown[] | undefined),
      };
    } catch {
      // Not this ABI — try the next.
    }
  }
  return null;
}

/**
 * Decode an event log against the ABIs we know, favouring the emitter's
 * primary ABI. Silently returns null on mismatch — the UI is expected to
 * keep showing the raw topics in that case.
 */
export function decodeLog(
  address: Address | null | undefined,
  topics: readonly Hex[],
  data: Hex,
): DecodedLog | null {
  if (topics.length === 0) return null;
  for (const { name, abi } of abisForAddress(address)) {
    try {
      const decoded = decodeEventLog({
        abi,
        data,
        // viem's type is `[signature: Hex, ...args: Hex[]]`; the call site
        // has a plain Hex[] because we're copying from an rpc log. Cast.
        topics: topics as unknown as [Hex, ...Hex[]],
      });
      // For a generic `Abi`, viem types `eventName` as possibly undefined;
      // in practice it's always populated when the call resolves. Guard
      // anyway so the UI never sees a half-decoded record.
      if (!decoded.eventName) continue;
      const inputs = eventInputs(abi, decoded.eventName);
      return {
        abiName: name,
        eventName: decoded.eventName,
        args: zipArgs(inputs, decoded.args as readonly unknown[] | Record<string, unknown> | undefined),
      };
    } catch {
      // Not this ABI — try the next.
    }
  }
  return null;
}

/**
 * Token-decimals lookup for the three protocol ERC-20s. Used by the UI
 * layer to render "1.5 ETX" next to raw bigints on known-token calls —
 * we don't try to fetch `decimals()` dynamically because the explorer
 * renders on every request and the round-trip would hurt page load.
 */
const TOKEN_DECIMALS_BY_ADDRESS: Record<string, { symbol: string; decimals: number }> = (() => {
  const map: Record<string, { symbol: string; decimals: number }> = {};
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (d?.etx && d.etx !== ZERO_ADDRESS) {
    map[d.etx.toLowerCase()] = { symbol: 'ETX', decimals: 18 };
  }
  if (d?.wegaz && d.wegaz !== ZERO_ADDRESS) {
    map[d.wegaz.toLowerCase()] = { symbol: 'WEGAZ', decimals: 18 };
  }
  if (ext?.eti && ext.eti !== ZERO_ADDRESS) {
    map[ext.eti.toLowerCase()] = { symbol: 'ETI', decimals: 18 };
  }
  return map;
})();

export function tokenMeta(
  address: Address | string | null | undefined,
): { symbol: string; decimals: number } | null {
  if (!address) return null;
  return TOKEN_DECIMALS_BY_ADDRESS[address.toLowerCase()] ?? null;
}

/**
 * Best-effort hint that an ABI arg holds a token amount for a token whose
 * decimals the UI already knows — used by the tx-page renderer to annotate
 * raw bigints with the human-readable "(1.5 ETX)" tail.
 */
const TOKEN_AMOUNT_ARG_NAMES = new Set([
  'amount',
  'amounts',
  'value',
  'wad',
  'rawAmount',
  'amountIn',
  'amountOut',
  'amountInMax',
  'amountOutMin',
]);

export function isTokenAmountArg(arg: DecodedArg): boolean {
  if (!arg.type.startsWith('uint')) return false;
  return TOKEN_AMOUNT_ARG_NAMES.has(arg.name);
}

/**
 * Re-export so consumers that need a safe checksum for rendering can
 * avoid importing viem alongside this module.
 */
export { getAddress };
