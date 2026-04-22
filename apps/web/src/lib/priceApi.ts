/**
 * Server-side helpers for the /api/v1/* price + market-data routes (F.12.b).
 *
 * Like the explorer (F.12.a), the price API does not run an indexer. Every
 * response is computed from on-chain state via a `PublicClient`. That means:
 *
 *   - Prices are *current spot* only, derived from EticaSwap V2 pair reserves.
 *     No historical candles, no 24h-volume numbers, no open-interest figures.
 *     When we ship an indexer (F.12.c), the same shapes will start returning
 *     real 24h/7d stats without breaking clients.
 *   - Prices are *relative* to other Etica tokens (ETX / EGAZ / ETI). There
 *     is no reliable USD anchor for ETI/ETX/EGAZ that we control at the
 *     protocol level — aggregators that list us will supply their own USD
 *     reference rate and multiply.
 *   - We cache each route at the Next.js layer (`revalidate`) so a burst of
 *     aggregator polls doesn't hammer the RPC.
 *
 * All functions here are intended for Route Handlers / Server Components and
 * must never be imported from a `'use client'` module.
 */

import {
  createPublicClient,
  http,
  getAddress,
  isAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { abis, DEPLOYMENTS, EXTERNAL_ADDRESSES, eticaMainnet } from '@etica-hub/shared';

const MAINNET_CHAIN_ID = 61803;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** Default route-segment cache window for every `/api/v1/*` endpoint. */
export const API_REVALIDATE_SECONDS = 30;

/** JSON response headers that let any dapp consume the API cross-origin. */
export const JSON_HEADERS: HeadersInit = {
  'content-type': 'application/json; charset=utf-8',
  // Public read-only API — safe to open to any origin.
  'access-control-allow-origin': '*',
  // Mirror the cache window so browsers + CDNs don't over-poll.
  'cache-control': `public, s-maxage=${API_REVALIDATE_SECONDS}, stale-while-revalidate=${API_REVALIDATE_SECONDS * 2}`,
};

// ---- client ---------------------------------------------------------------

function getPriceClient(): PublicClient {
  const override = process.env.ETICA_MAINNET_RPC_URL;
  return createPublicClient({
    chain: eticaMainnet,
    transport: override ? http(override) : http(),
  }) as PublicClient;
}

let cachedClient: PublicClient | null = null;
export function priceClient(): PublicClient {
  if (!cachedClient) cachedClient = getPriceClient();
  return cachedClient;
}

// ---- token registry -------------------------------------------------------

/**
 * A token as exposed by the price API. `nativeSymbol` marks the EGAZ pseudo-
 * token, which is the chain's native coin and has no ERC-20 address of its
 * own — we return WEGAZ's address as `wrappedAddress` and treat the two as
 * interchangeable 1:1 for price purposes.
 */
export interface ApiToken {
  /** Stable machine id (lowercase). Used as the CoinGecko-style `ids` key. */
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  /** ERC-20 address, or `null` for native EGAZ. */
  address: Address | null;
  /**
   * For native tokens: address of the canonical wrapped ERC-20
   * (e.g. WEGAZ for EGAZ). `null` for ERC-20s themselves.
   */
  wrappedAddress: Address | null;
  /** True for the native chain coin (EGAZ). */
  isNative: boolean;
}

function assertMainnetDeployments() {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (!d) throw new Error('No DEPLOYMENTS entry for chain 61803');
  if (!ext) throw new Error('No EXTERNAL_ADDRESSES entry for chain 61803');
  return { d, ext };
}

/**
 * The fixed set of tokens the price API reports on today. The launchpad can
 * mint arbitrary ERC-20s via the factory, but they have no guaranteed pair
 * with ETX until someone seeds liquidity — we'll add an on-demand lookup
 * path for those in F.12.b.2 rather than blocking the first ship on it.
 */
export function apiTokens(): ApiToken[] {
  const { d, ext } = assertMainnetDeployments();
  return [
    {
      id: 'egaz',
      symbol: 'EGAZ',
      name: 'Etica Gas',
      decimals: 18,
      address: null,
      wrappedAddress: d.wegaz,
      isNative: true,
    },
    {
      id: 'wegaz',
      symbol: 'WEGAZ',
      name: 'Wrapped Etica Gas',
      decimals: 18,
      address: d.wegaz,
      wrappedAddress: null,
      isNative: false,
    },
    {
      id: 'etx',
      symbol: 'ETX',
      name: 'EticaHub',
      decimals: 18,
      address: d.etx,
      wrappedAddress: null,
      isNative: false,
    },
    {
      id: 'eti',
      symbol: 'ETI',
      name: 'Etica',
      decimals: 18,
      address: ext.eti,
      wrappedAddress: null,
      isNative: false,
    },
  ];
}

/** Finds a token by CoinGecko-style id (case-insensitive). */
export function tokenById(id: string): ApiToken | null {
  const needle = id.toLowerCase();
  return apiTokens().find((t) => t.id === needle) ?? null;
}

/** Finds a token by its ERC-20 address (case-insensitive). */
export function tokenByAddress(addr: Address | string): ApiToken | null {
  if (!isAddress(addr, { strict: false })) return null;
  const checksummed = getAddress(addr);
  return (
    apiTokens().find((t) => t.address && getAddress(t.address) === checksummed) ??
    null
  );
}

// ---- pair discovery + reserves -------------------------------------------

export interface ApiPairRaw {
  address: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: number;
  totalSupply: bigint;
}

/**
 * Returns the full set of pairs registered on the EticaSwap factory.
 *
 * The factory enforces "hub and spoke" (every pair contains ETX), so pair
 * count is on the order of `listed-tokens + 1` — small enough to fetch in a
 * single batched multicall. If that ever stops being true we'll add
 * pagination to this endpoint rather than the callers.
 */
export async function fetchAllPairs(client: PublicClient = priceClient()): Promise<ApiPairRaw[]> {
  const { d } = assertMainnetDeployments();
  if (d.swapFactory === ZERO_ADDRESS) return [];
  const len = (await client.readContract({
    abi: abis.factoryAbi,
    address: d.swapFactory,
    functionName: 'allPairsLength',
  })) as bigint;
  const n = Number(len);
  if (n === 0) return [];

  // Pull every pair address in parallel.
  const addresses = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      client.readContract({
        abi: abis.factoryAbi,
        address: d.swapFactory,
        functionName: 'allPairs',
        args: [BigInt(i)],
      }) as Promise<Address>,
    ),
  );

  // Then per-pair state in parallel. Each pair costs 4 RPC calls; with the
  // hub-and-spoke invariant this is still small in absolute terms.
  const enriched = await Promise.all(
    addresses.map(async (pair) => {
      const [token0, token1, reserves, totalSupply] = await Promise.all([
        client.readContract({
          abi: abis.pairAbi,
          address: pair,
          functionName: 'token0',
        }) as Promise<Address>,
        client.readContract({
          abi: abis.pairAbi,
          address: pair,
          functionName: 'token1',
        }) as Promise<Address>,
        client.readContract({
          abi: abis.pairAbi,
          address: pair,
          functionName: 'getReserves',
        }) as Promise<readonly [bigint, bigint, number]>,
        client.readContract({
          abi: abis.pairAbi,
          address: pair,
          functionName: 'totalSupply',
        }) as Promise<bigint>,
      ]);
      return {
        address: pair,
        token0,
        token1,
        reserve0: reserves[0],
        reserve1: reserves[1],
        blockTimestampLast: reserves[2],
        totalSupply,
      } satisfies ApiPairRaw;
    }),
  );
  return enriched;
}

export async function fetchPairByAddress(
  pair: Address,
  client: PublicClient = priceClient(),
): Promise<ApiPairRaw | null> {
  try {
    const [token0, token1, reserves, totalSupply] = await Promise.all([
      client.readContract({
        abi: abis.pairAbi,
        address: pair,
        functionName: 'token0',
      }) as Promise<Address>,
      client.readContract({
        abi: abis.pairAbi,
        address: pair,
        functionName: 'token1',
      }) as Promise<Address>,
      client.readContract({
        abi: abis.pairAbi,
        address: pair,
        functionName: 'getReserves',
      }) as Promise<readonly [bigint, bigint, number]>,
      client.readContract({
        abi: abis.pairAbi,
        address: pair,
        functionName: 'totalSupply',
      }) as Promise<bigint>,
    ]);
    // A non-contract address returns 0x for every call — viem will throw on
    // decode before we get here, which the try/catch turns into `null`.
    return {
      address: pair,
      token0,
      token1,
      reserve0: reserves[0],
      reserve1: reserves[1],
      blockTimestampLast: reserves[2],
      totalSupply,
    };
  } catch {
    return null;
  }
}

// ---- price derivation -----------------------------------------------------

/**
 * Spot price of `base` denominated in `quote`, derived from `pair`'s reserves.
 * Returns `null` when the pair doesn't contain both tokens or a reserve is 0.
 *
 * Both tokens on Etica's live deployments are 18-decimals, so the math is
 * just `reserveQuote / reserveBase` once we know the pair orientation. We
 * still carry decimals through the API so the formula remains correct if we
 * ever list a non-18-decimal token.
 */
export function spotPriceFromReserves(
  pair: ApiPairRaw,
  base: ApiToken,
  quote: ApiToken,
): number | null {
  const baseAddr = base.address ?? base.wrappedAddress;
  const quoteAddr = quote.address ?? quote.wrappedAddress;
  if (!baseAddr || !quoteAddr) return null;

  const t0 = getAddress(pair.token0);
  const t1 = getAddress(pair.token1);
  const b = getAddress(baseAddr);
  const q = getAddress(quoteAddr);

  let reserveBase: bigint;
  let reserveQuote: bigint;
  if (b === t0 && q === t1) {
    reserveBase = pair.reserve0;
    reserveQuote = pair.reserve1;
  } else if (b === t1 && q === t0) {
    reserveBase = pair.reserve1;
    reserveQuote = pair.reserve0;
  } else {
    return null;
  }
  if (reserveBase === 0n || reserveQuote === 0n) return null;

  // Ratio of two uint112s fits comfortably in a JS number for any reasonable
  // reserve balance (max ratio is < 2^112). We scale by decimals to keep the
  // per-unit interpretation correct across heterogeneous decimals.
  const baseScaled = Number(reserveBase) / 10 ** base.decimals;
  const quoteScaled = Number(reserveQuote) / 10 ** quote.decimals;
  if (baseScaled === 0) return null;
  return quoteScaled / baseScaled;
}

/**
 * Returns the spot price of `base` denominated in `quote` by searching the
 * set of fetched pairs. Supports one-hop routing via ETX (the hub token):
 *
 *   price(A → B) = price(A → ETX) * price(ETX → B)
 *
 * EGAZ ↔ WEGAZ are treated as a fixed 1:1 since they're wrapped/unwrapped
 * 1:1 by the WEGAZ contract.
 */
export function priceVia(
  pairs: ApiPairRaw[],
  base: ApiToken,
  quote: ApiToken,
): number | null {
  if (base.id === quote.id) return 1;
  // EGAZ <-> WEGAZ shortcut.
  if ((base.id === 'egaz' && quote.id === 'wegaz') || (base.id === 'wegaz' && quote.id === 'egaz')) {
    return 1;
  }

  const direct = pairs
    .map((p) => spotPriceFromReserves(p, base, quote))
    .find((x) => x !== null);
  if (direct !== undefined && direct !== null) return direct;

  // One-hop via ETX.
  const etx = tokenById('etx');
  if (!etx || base.id === 'etx' || quote.id === 'etx') return null;
  const legA = pairs
    .map((p) => spotPriceFromReserves(p, base, etx))
    .find((x) => x !== null);
  const legB = pairs
    .map((p) => spotPriceFromReserves(p, etx, quote))
    .find((x) => x !== null);
  if (legA == null || legB == null) return null;
  return legA * legB;
}

// ---- serialization --------------------------------------------------------

/**
 * `JSON.stringify` replacer that renders bigints as base-10 strings. Applied
 * to every API response so clients don't have to special-case `BigInt`.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const status = init?.status ?? 200;
  return new Response(JSON.stringify(body, jsonReplacer), {
    ...init,
    status,
    headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function jsonError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: message, ...extra }, { status });
}
