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
  parseAbiItem,
  type Address,
  type PublicClient,
} from 'viem';
import { abis, DEPLOYMENTS, EXTERNAL_ADDRESSES, eticaMainnet } from '@etica-hub/shared';
import { fetchIndexedPairSyncs } from './explorerIndex';

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
  const tokens: ApiToken[] = [
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
  // stETX is the ERC-4626 liquid-staking receipt for ETX. Only surface it in
  // the token registry once the vault has been deployed on the target chain —
  // pre-deploy chains carry the zero address as a placeholder, and emitting a
  // token entry for `0x0` would poison every pair-symbol resolution.
  if (d.stakedETX && d.stakedETX !== ZERO_ADDRESS) {
    tokens.push({
      id: 'stetx',
      symbol: 'stETX',
      name: 'Staked ETX',
      decimals: 18,
      address: d.stakedETX,
      wrappedAddress: null,
      isNative: false,
    });
  }
  return tokens;
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

// ---- ERC-20 helpers -------------------------------------------------------

/**
 * Minimal ERC-20 ABI fragment used by the public price API. We declare it
 * locally rather than pulling the OpenZeppelin JSON so the API route has no
 * dependency on the contracts package.
 */
const ERC20_READ_ABI = [
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * Canonical dead-address used by {TreasuryHarvester} when permanently locking
 * POL LP. Any ETX sent here is considered burned for the purposes of
 * circulating-supply math.
 */
export const BURN_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';

/**
 * For circulating-supply math we subtract a fixed list of "not-in-circulation"
 * holders. The treasury multisig counts because it is the programmatic source
 * of supply for the stETX vault + TreasuryHarvester and is not freely tradable.
 * Keeping this list tight so we don't accidentally under-report.
 */
function circulatingExcludedHolders(): Address[] {
  return [BURN_ADDRESS];
}

export async function fetchErc20TotalSupply(
  token: Address,
  client: PublicClient = priceClient(),
): Promise<bigint> {
  return (await client.readContract({
    abi: ERC20_READ_ABI,
    address: token,
    functionName: 'totalSupply',
  })) as bigint;
}

export async function fetchErc20Balance(
  token: Address,
  holder: Address,
  client: PublicClient = priceClient(),
): Promise<bigint> {
  return (await client.readContract({
    abi: ERC20_READ_ABI,
    address: token,
    functionName: 'balanceOf',
    args: [holder],
  })) as bigint;
}

export interface TokenSupplyStats {
  /** Raw uint256 total supply as returned by the token. */
  totalSupply: bigint;
  /** Amount held at {BURN_ADDRESS} and treated as permanently removed. */
  burned: bigint;
  /**
   * Total supply minus the list of excluded holders (burn + treasury-locked
   * if applicable). Aggregators poll this as "circulating".
   */
  circulatingSupply: bigint;
  /** The addresses that were subtracted (in checksummed form) for reference. */
  excludedHolders: Address[];
}

/**
 * Read the supply stats for an ERC-20 token tracked by the price API. The
 * returned numbers are raw uint256s — callers format with the token's
 * {decimals} before rendering.
 */
export async function fetchTokenSupplyStats(
  token: ApiToken,
  client: PublicClient = priceClient(),
): Promise<TokenSupplyStats | null> {
  if (!token.address) return null;
  const totalSupply = await fetchErc20TotalSupply(token.address, client);
  const excluded = circulatingExcludedHolders();
  const balances = await Promise.all(
    excluded.map((h) => fetchErc20Balance(token.address as Address, h, client)),
  );
  const burnedIdx = excluded.findIndex(
    (h) => getAddress(h) === getAddress(BURN_ADDRESS),
  );
  const burned = burnedIdx === -1 ? 0n : balances[burnedIdx];
  const subtract = balances.reduce((acc, b) => acc + b, 0n);
  const circulating = totalSupply > subtract ? totalSupply - subtract : 0n;
  return {
    totalSupply,
    burned,
    circulatingSupply: circulating,
    excludedHolders: excluded.map((h) => getAddress(h)),
  };
}

/**
 * Format a raw uint256 token amount to a fixed-decimal string. Keeps full
 * precision so plain-text supply endpoints return the exact on-chain value.
 */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return `${neg ? '-' : ''}${whole.toString()}`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`;
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

// ---- OHLCV candles from Sync events --------------------------------------

/**
 * Supported candle intervals. Values are seconds-per-candle, keys are the
 * user-facing query parameter accepted by `/api/v1/ohlcv/{pair}?interval=…`.
 */
export const OHLCV_INTERVALS = {
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
} as const;
export type OhlcvInterval = keyof typeof OHLCV_INTERVALS;

/** Etica's ~5s blocktime, used to estimate a block range from a time range. */
export const ETICA_AVG_BLOCKTIME_SECONDS = 5;

/** Max candles returned in one response. Keeps worst-case payload bounded. */
export const OHLCV_MAX_CANDLES = 500;
export const OHLCV_DEFAULT_CANDLES = 100;

/** Pair `Sync(uint112, uint112)` event — same signature as Uniswap V2. */
export const SYNC_EVENT = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');

/** Upper bound on blocks per getLogs page. Most RPCs cap at 10k. */
const LOGS_PAGE_BLOCKS_DEFAULT = 10_000n;
const LOGS_PAGE_BLOCKS_MIN = 500n;

export interface SyncSample {
  /** Unix seconds, estimated from block number if the log didn't carry it. */
  timestamp: number;
  /** Price of `base` denominated in `quote` at this sync. */
  price: number;
}

export interface Candle {
  /** Unix seconds of the bucket start. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Sync-event count in this bucket. Proxy for trade activity until we ship true volume. */
  samples: number;
}

/**
 * Fetch raw `Sync` logs for `pair` between `[fromBlock, toBlock]`, paginated
 * with exponential backoff on RPC range errors. Mirrors the client-side
 * backfill the chart uses (see `OnChainPriceChart.tsx`) but runs on the
 * server so the response can be cached at the CDN and shared across
 * clients.
 */
export async function fetchSyncLogs(
  pair: Address,
  fromBlock: bigint,
  toBlock: bigint,
  client: PublicClient = priceClient(),
): Promise<
  Array<{
    blockNumber: bigint | null;
    reserve0: bigint;
    reserve1: bigint;
  }>
> {
  const out: Array<{ blockNumber: bigint | null; reserve0: bigint; reserve1: bigint }> = [];
  let pageSize = LOGS_PAGE_BLOCKS_DEFAULT;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + pageSize - 1n > toBlock ? toBlock : cursor + pageSize - 1n;
    try {
      const logs = await client.getLogs({
        address: pair,
        event: SYNC_EVENT,
        fromBlock: cursor,
        toBlock: end,
      });
      for (const log of logs) {
        const r0 = log.args.reserve0;
        const r1 = log.args.reserve1;
        if (r0 == null || r1 == null) continue;
        out.push({
          blockNumber: log.blockNumber ?? null,
          reserve0: r0,
          reserve1: r1,
        });
      }
      cursor = end + 1n;
    } catch (err) {
      if (pageSize <= LOGS_PAGE_BLOCKS_MIN) throw err;
      pageSize = pageSize / 2n;
      if (pageSize < LOGS_PAGE_BLOCKS_MIN) pageSize = LOGS_PAGE_BLOCKS_MIN;
    }
  }
  return out;
}

/**
 * Hard cap on the RPC tail-scan window when the indexer cursor has
 * fallen behind. Matches the widest single `eth_getLogs` window any
 * other part of the explorer uses, so worst-case behaviour is
 * bounded even if the cron has been down for hours.
 */
const SYNC_TAIL_MAX_BLOCKS = 10_000n;

export interface SyncLog {
  blockNumber: bigint | null;
  reserve0: bigint;
  reserve1: bigint;
}

/**
 * Indexer-aware Sync-log loader. Reads historical syncs for `pair`
 * from the indexer's `data-index` branch and RPC-scans the tail
 * between the indexer cursor and `toBlock` so recent ticks appear
 * without waiting on the next cron. Dedupes on
 * `(blockNumber, reserve0, reserve1)` — a pair emitting multiple
 * Syncs in the same block with identical reserves (e.g. two pokes
 * in the same tx) is rare enough that treating them as one row is
 * fine for charting.
 *
 * When the indexer is unavailable (data branch missing, network
 * error) falls back to the plain RPC scan so charts still render
 * for the short-range windows the OHLCV route asks for.
 */
export async function loadSyncLogsForOhlcv(
  pair: Address,
  fromBlock: bigint,
  toBlock: bigint,
  client: PublicClient = priceClient(),
): Promise<SyncLog[]> {
  // Probe the indexer over a comfortable lookback window. OHLCV requests
  // bounded by `limit * intervalSeconds`, so the widest realistic ask
  // (500 candles × 1d) is ~500 days; we cap at 365 which covers anything
  // aggregators actually poll for while keeping the JSONL fan-out sane.
  const indexed = await fetchIndexedPairSyncs(pair.toLowerCase(), 365);
  if (!indexed) {
    return fetchSyncLogs(pair, fromBlock, toBlock, client);
  }
  const cursorBlock = BigInt(indexed.cursor.lastBlock);
  const resumeFrom = cursorBlock + 1n > fromBlock ? cursorBlock + 1n : fromBlock;
  const tailFloor = toBlock > SYNC_TAIL_MAX_BLOCKS ? toBlock - SYNC_TAIL_MAX_BLOCKS : 0n;
  const tailFrom = resumeFrom > tailFloor ? resumeFrom : tailFloor;
  const tail: SyncLog[] =
    tailFrom <= toBlock ? await fetchSyncLogs(pair, tailFrom, toBlock, client) : [];

  const seen = new Set<string>();
  const out: SyncLog[] = [];
  for (const row of tail) {
    const key = `${row.blockNumber?.toString() ?? 'x'}:${row.reserve0}:${row.reserve1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  for (const r of indexed.rows) {
    const bn = BigInt(r.block);
    if (bn < fromBlock || bn > toBlock) continue;
    const row: SyncLog = {
      blockNumber: bn,
      reserve0: BigInt(r.reserve0),
      reserve1: BigInt(r.reserve1),
    };
    const key = `${bn.toString()}:${row.reserve0}:${row.reserve1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  out.sort((a, b) => {
    const ax = a.blockNumber ?? 0n;
    const bx = b.blockNumber ?? 0n;
    if (ax === bx) return 0;
    return ax < bx ? -1 : 1;
  });
  return out;
}

/**
 * Turn a sorted list of `Sync` samples into OHLC candles bucketed at
 * `intervalSeconds`. `from` and `to` are inclusive unix-second bounds. The
 * result always contains `Math.floor((to - from) / intervalSeconds) + 1`
 * slots; buckets with no samples inherit the previous close (so the chart
 * line is continuous — mirrors how exchanges render empty candles).
 *
 * Exported for unit testing. The public route handler calls this on the
 * output of `fetchSyncLogs` + `spotPriceFromReserves`.
 */
export function aggregateCandles(
  samples: SyncSample[],
  intervalSeconds: number,
  from: number,
  to: number,
): Candle[] {
  if (intervalSeconds <= 0) return [];
  if (to < from) return [];
  const firstBucket = Math.floor(from / intervalSeconds) * intervalSeconds;
  const lastBucket = Math.floor(to / intervalSeconds) * intervalSeconds;
  const bucketCount = Math.floor((lastBucket - firstBucket) / intervalSeconds) + 1;

  const sorted = samples.slice().sort((a, b) => a.timestamp - b.timestamp);

  const candles: Candle[] = [];
  let prevClose: number | null = null;
  let cursor = 0;
  for (let i = 0; i < bucketCount; i += 1) {
    const bucketStart = firstBucket + i * intervalSeconds;
    const bucketEnd = bucketStart + intervalSeconds;
    let o: number | null = null;
    let h: number | null = null;
    let l: number | null = null;
    let c: number | null = null;
    let count = 0;
    while (cursor < sorted.length && sorted[cursor].timestamp < bucketEnd) {
      const s = sorted[cursor];
      if (s.timestamp < bucketStart) {
        // Any sample predating the window advances prevClose so the first
        // real bucket inherits a sensible open instead of 0.
        prevClose = s.price;
        cursor += 1;
        continue;
      }
      if (o == null) o = s.price;
      if (h == null || s.price > h) h = s.price;
      if (l == null || s.price < l) l = s.price;
      c = s.price;
      count += 1;
      cursor += 1;
    }
    if (o == null) {
      if (prevClose == null) continue; // no baseline yet — drop the bucket
      candles.push({ t: bucketStart, o: prevClose, h: prevClose, l: prevClose, c: prevClose, samples: 0 });
    } else {
      // Guaranteed non-null below because `o` was set in the loop above.
      const open = o;
      const high = h ?? open;
      const low = l ?? open;
      const close = c ?? open;
      candles.push({ t: bucketStart, o: open, h: high, l: low, c: close, samples: count });
      prevClose = close;
    }
  }
  return candles;
}

// ---- health --------------------------------------------------------------

/** Head-block age in seconds relative to wall-clock, capped at ±1 day. */
export function headBlockAgeSeconds(headTimestampSeconds: number, now: number = Math.floor(Date.now() / 1000)): number {
  const delta = now - headTimestampSeconds;
  const capped = Math.max(-86_400, Math.min(86_400, delta));
  return capped;
}

// ---- pair volume ---------------------------------------------------------

/**
 * Pair `Swap(address,uint256,uint256,uint256,uint256,address)` event —
 * same signature as Uniswap V2. Emitted exactly once per token swap, so
 * summing `amountInXxx` fields gives volume directly (no deduping needed
 * beyond ordinary reorg semantics).
 */
export const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);

/** Default reporting window for `/api/v1/pairs/{pair}/volume`. */
export const VOLUME_WINDOW_24H_SECONDS = 24 * 60 * 60;

export interface PairVolumeSummary {
  /** Sum of amounts of `token0` that moved through the pair (in + out). */
  volume0: bigint;
  /** Sum of amounts of `token1` that moved through the pair (in + out). */
  volume1: bigint;
  /** Number of Swap events observed in the window. */
  swapCount: number;
}

/**
 * Fetch raw `Swap` logs for `pair` over `[fromBlock, toBlock]`, paginated
 * with the same exponential-backoff pattern as {@link fetchSyncLogs} so
 * we stay below RPC per-range limits on large scans.
 */
export async function fetchSwapLogs(
  pair: Address,
  fromBlock: bigint,
  toBlock: bigint,
  client: PublicClient = priceClient(),
): Promise<
  Array<{
    blockNumber: bigint | null;
    amount0In: bigint;
    amount1In: bigint;
    amount0Out: bigint;
    amount1Out: bigint;
  }>
> {
  const out: Array<{
    blockNumber: bigint | null;
    amount0In: bigint;
    amount1In: bigint;
    amount0Out: bigint;
    amount1Out: bigint;
  }> = [];
  let pageSize = LOGS_PAGE_BLOCKS_DEFAULT;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + pageSize - 1n > toBlock ? toBlock : cursor + pageSize - 1n;
    try {
      const logs = await client.getLogs({
        address: pair,
        event: SWAP_EVENT,
        fromBlock: cursor,
        toBlock: end,
      });
      for (const log of logs) {
        out.push({
          blockNumber: log.blockNumber ?? null,
          amount0In: log.args.amount0In ?? 0n,
          amount1In: log.args.amount1In ?? 0n,
          amount0Out: log.args.amount0Out ?? 0n,
          amount1Out: log.args.amount1Out ?? 0n,
        });
      }
      cursor = end + 1n;
    } catch (err) {
      if (pageSize <= LOGS_PAGE_BLOCKS_MIN) throw err;
      pageSize = pageSize / 2n;
      if (pageSize < LOGS_PAGE_BLOCKS_MIN) pageSize = LOGS_PAGE_BLOCKS_MIN;
    }
  }
  return out;
}

/**
 * Reduces a set of Swap events into per-token turnover. V2 emits exactly
 * one Swap per swap, with either (amount0In, amount1Out) or (amount1In,
 * amount0Out) non-zero. "Volume" for token N is `amountNIn + amountNOut`,
 * i.e. the gross flow regardless of direction — this matches how
 * Uniswap / Sushi / Aerodrome surface per-pair volume.
 */
export function summarizeSwapVolume(
  logs: Array<{ amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }>,
): PairVolumeSummary {
  let volume0 = 0n;
  let volume1 = 0n;
  for (const l of logs) {
    volume0 += l.amount0In + l.amount0Out;
    volume1 += l.amount1In + l.amount1Out;
  }
  return { volume0, volume1, swapCount: logs.length };
}

/**
 * Convenience wrapper: derive the block window for the last `windowSeconds`
 * (default 24h) using the chain's average blocktime, then fetch + sum.
 * Both the raw summary and the computed window are returned so callers
 * can report the exact block range they scanned.
 */
export async function loadPairVolume(
  pair: Address,
  windowSeconds: number = VOLUME_WINDOW_24H_SECONDS,
  client: PublicClient = priceClient(),
): Promise<{
  summary: PairVolumeSummary;
  fromBlock: bigint;
  toBlock: bigint;
  fromTs: number;
  toTs: number;
}> {
  const head = await client.getBlock({ blockTag: 'latest' });
  const toBlock = head.number;
  const toTs = Number(head.timestamp);
  const approxBlocks = BigInt(Math.ceil(windowSeconds / ETICA_AVG_BLOCKTIME_SECONDS));
  const fromBlock = toBlock > approxBlocks ? toBlock - approxBlocks : 0n;
  const fromTs = toTs - windowSeconds;
  const logs = await fetchSwapLogs(pair, fromBlock, toBlock, client);
  return { summary: summarizeSwapVolume(logs), fromBlock, toBlock, fromTs, toTs };
}
