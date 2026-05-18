'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, parseAbiItem, type Address, type PublicClient } from 'viem';
import { useChainId, usePublicClient, useReadContract } from 'wagmi';
import { DEPLOYMENTS, abis } from '@etica-hub/shared';
import { resolveBaseTokenAddress, type TradeBaseSymbol } from '@/lib/trading/baseSymbol';
import {
  filterSamplesToWindow,
  invertPrice,
  priceHeadline,
  TIME_WINDOW_LABELS,
  TIME_WINDOWS,
  type TimeWindow,
} from '@/lib/trading/priceLabel';
import { BrandCandleChart, type BrandCandle } from '@/components/BrandCandleChart';

/**
 * Client-side price chart fallback.
 *
 * When the price indexer (apps/indexer) is not deployed, there is no
 * `NEXT_PUBLIC_PRICES_API_URL` to fetch pre-bucketed candles from. Instead,
 * we derive a live spot price directly from each pair's on-chain reserves
 * via wagmi polling, and build a rolling sample buffer in component state.
 *
 * Trade-offs vs. the indexer-backed `PriceChart`:
 *   - No history on page reload — buffer is re-seeded from the current block.
 *   - No true OHLC bucketing — we plot raw reserve-derived closes.
 *   - Slightly heavier RPC usage — one `getReserves()` per `pollIntervalMs`.
 *   - $0 infrastructure — works against the user's connected RPC.
 */

const ZERO: Address = '0x0000000000000000000000000000000000000000';
// Poll interval between reserve samples, in milliseconds. ~8s gives a decent
// live feel without hammering the RPC.
const POLL_INTERVAL_MS = 8_000;
// Rolling buffer size. Was 240 (~32 min at 8s poll) when the chart was live
// only; bumped to carry historical Sync-event samples alongside live polls.
const MAX_SAMPLES = 2_000;
// How far back we try to backfill history on first load when the cache is
// empty. Capped to avoid hammering the RPC with huge ranges; most public
// Etica RPCs cap getLogs to ~10k blocks per call anyway.
const HISTORY_BACKFILL_BLOCKS = 20_000n;
// How many blocks we ask for per getLogs page. Shrunk on range errors.
const LOGS_PAGE_BLOCKS_DEFAULT = 10_000n;
const LOGS_PAGE_BLOCKS_MIN = 500n;
// Etica's average blocktime (~5s). We estimate per-log timestamps by
// anchoring on the chain head's timestamp and walking backwards; good enough
// for a chart, avoids O(N) eth_getBlockByNumber calls across every log.
const ETICA_BLOCKTIME_S = 5;
// localStorage cache schema version — bump to invalidate old entries.
const CACHE_SCHEMA_VERSION = 1;

type Sample = { ts: number; price: number };

interface OnChainPriceChartProps {
  baseSymbol: TradeBaseSymbol;
  quoteSymbol: string;
}

export function OnChainPriceChart({ baseSymbol, quoteSymbol }: OnChainPriceChartProps) {
  // Visualization-only state. The full sample buffer is preserved in
  // localStorage so toggling these never throws away on-chain history.
  const [windowKey, setWindowKey] = useState<TimeWindow>('7d');
  const [inverted, setInverted] = useState(false);

  const chainId = useChainId();
  const deployment = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS];

  const resolvedBase = resolveBaseTokenAddress(chainId, baseSymbol);
  const baseAddress: Address | undefined = resolvedBase !== ZERO ? resolvedBase : undefined;
  const quoteAddress = deployment?.etx;

  // 1) Resolve the pair address once per chain/symbol combo.
  const pairQuery = useReadContract({
    abi: abis.factoryAbi,
    address: deployment?.swapFactory,
    functionName: 'getPair',
    args:
      baseAddress && quoteAddress && baseAddress !== ZERO && quoteAddress !== ZERO
        ? [baseAddress, quoteAddress]
        : undefined,
    query: {
      enabled: Boolean(
        deployment?.swapFactory &&
        deployment.swapFactory !== ZERO &&
        baseAddress &&
        baseAddress !== ZERO &&
        quoteAddress &&
        quoteAddress !== ZERO,
      ),
    },
  });
  const pair = (pairQuery.data as Address | undefined) ?? undefined;
  const pairDeployed = Boolean(pair && pair !== ZERO);

  // 2) Resolve whether the base token is token0 on the pair (fixes reserve
  // ordering regardless of how the factory sorted the pair at create time).
  const token0Query = useReadContract({
    abi: abis.pairAbi,
    address: pairDeployed ? pair : undefined,
    functionName: 'token0',
    query: { enabled: pairDeployed },
  });
  const baseIsToken0 = useMemo(() => {
    const t0 = token0Query.data as Address | undefined;
    if (!t0 || !baseAddress) return null;
    return t0.toLowerCase() === baseAddress.toLowerCase();
  }, [token0Query.data, baseAddress]);

  // 3) Poll reserves every POLL_INTERVAL_MS.
  const reservesQuery = useReadContract({
    abi: abis.pairAbi,
    address: pairDeployed ? pair : undefined,
    functionName: 'getReserves',
    query: {
      enabled: pairDeployed && baseIsToken0 !== null,
      refetchInterval: POLL_INTERVAL_MS,
      refetchIntervalInBackground: false,
    },
  });

  // 4) Derive a close-price and append to the rolling buffer on each poll.
  const [samples, setSamples] = useState<Sample[]>([]);
  // Separate from `samples`: the last block we've ingested via the history
  // backfill + live event log path. Used to paginate new pulls forward.
  // Kept in a ref — not state — so the backfill effect can read the latest
  // value without being in its dependency array (which would re-run the
  // whole backfill every time it advances).
  const lastIngestedBlockRef = useRef<bigint | null>(null);
  const publicClient = usePublicClient();

  const cacheKey = useMemo(
    () => (pairDeployed && pair ? makeCacheKey(chainId, pair) : null),
    [chainId, pair, pairDeployed],
  );

  // Reset the buffer whenever the pair identity changes underneath us. The
  // `key={baseSymbol}` in TradeView already remounts on route change, but a
  // user could also switch the connected wallet's chain — which swaps the
  // resolved pair address without unmounting the component. Clearing state
  // here prevents mixing prices from two different chains into one chart.
  // We seed from localStorage in the same pass so refreshes feel instant.
  // Ref is updated synchronously alongside state so the backfill effect —
  // which runs in the same post-render phase — reads the cached frontier
  // instead of the stale `null` default.
  useEffect(() => {
    if (!cacheKey) {
      setSamples([]);
      lastIngestedBlockRef.current = null;
      return;
    }
    const cached = readChartCache(cacheKey);
    if (cached) {
      setSamples(cached.samples);
      lastIngestedBlockRef.current = cached.lastBlock;
    } else {
      setSamples([]);
      lastIngestedBlockRef.current = null;
    }
  }, [cacheKey]);

  // Backfill historical Sync events from the pair contract. Runs once the
  // pair + token ordering are resolved and whenever the cached frontier
  // advances (so returning users only pay for blocks minted since they last
  // visited). All retrieved samples are persisted back to localStorage so the
  // next page load is instant.
  useEffect(() => {
    if (!publicClient || !pairDeployed || !pair || baseIsToken0 === null || !cacheKey) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const head = await publicClient.getBlock({ blockTag: 'latest' });
        if (cancelled) return;
        const headNumber = head.number;
        const headTs = Number(head.timestamp);
        if (headNumber === null || headNumber === undefined) return;
        const priorFrontier = lastIngestedBlockRef.current;
        const fromBlock =
          priorFrontier !== null
            ? priorFrontier + 1n
            : headNumber > HISTORY_BACKFILL_BLOCKS
              ? headNumber - HISTORY_BACKFILL_BLOCKS
              : 0n;
        if (fromBlock > headNumber) return;
        const logs = await fetchSyncLogsPaginated(publicClient, pair, fromBlock, headNumber);
        if (cancelled) return;
        if (logs.length === 0) {
          // Still advance the frontier so we don't re-scan an empty range
          // every mount. Use a functional setter to read the current samples
          // (closure-captured `samples` would be stale here and would wipe
          // cached history on write-through).
          lastIngestedBlockRef.current = headNumber;
          setSamples((prev) => {
            writeChartCache(cacheKey, { lastBlock: headNumber, samples: prev });
            return prev;
          });
          return;
        }
        const newSamples: Sample[] = [];
        for (const log of logs) {
          const r0 = log.args.reserve0 as bigint | undefined;
          const r1 = log.args.reserve1 as bigint | undefined;
          if (r0 === undefined || r1 === undefined || log.blockNumber === null || log.blockNumber === undefined) continue;
          const baseReserve = baseIsToken0 ? r0 : r1;
          const quoteReserve = baseIsToken0 ? r1 : r0;
          if (baseReserve === 0n) continue;
          const price =
            Number(formatUnits(quoteReserve, 18)) / Number(formatUnits(baseReserve, 18));
          if (!Number.isFinite(price) || price <= 0) continue;
          const ts =
            headTs - Number(headNumber - log.blockNumber) * ETICA_BLOCKTIME_S;
          newSamples.push({ ts, price });
        }
        if (cancelled) return;
        setSamples((prev) => {
          const merged = [...prev, ...newSamples];
          merged.sort((a, b) => a.ts - b.ts);
          const capped =
            merged.length > MAX_SAMPLES ? merged.slice(-MAX_SAMPLES) : merged;
          writeChartCache(cacheKey, { lastBlock: headNumber, samples: capped });
          return capped;
        });
        lastIngestedBlockRef.current = headNumber;
      } catch (err) {
        // Swallow — the chart degrades gracefully to the live-poll path.
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.warn('[OnChainPriceChart] backfill failed', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally depend on `cacheKey` (identity) not `samples`, so this
    // effect runs once per pair/chain change and not on every sample append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, pairDeployed, pair, baseIsToken0, cacheKey]);

  useEffect(() => {
    const r = reservesQuery.data as readonly [bigint, bigint, number] | undefined;
    if (!r || baseIsToken0 === null) return;
    const [r0, r1] = r;
    const baseReserve = baseIsToken0 ? r0 : r1;
    const quoteReserve = baseIsToken0 ? r1 : r0;
    if (baseReserve === 0n) return;
    // Both tokens on Etica are 18-decimals, so the mid-price is a plain ratio
    // in human units without cross-decimal scaling.
    const price = Number(formatUnits(quoteReserve, 18)) / Number(formatUnits(baseReserve, 18));
    if (!Number.isFinite(price) || price <= 0) return;
    const sample: Sample = { ts: Math.floor(Date.now() / 1000), price };
    setSamples((prev) => {
      const next = [...prev, sample];
      if (next.length > MAX_SAMPLES) next.splice(0, next.length - MAX_SAMPLES);
      // Only persist once the backfill has advanced the frontier at least
      // once. Writing `0n` here would tell a future page load to re-scan
      // from block 1 (bypassing HISTORY_BACKFILL_BLOCKS, which only applies
      // when the stored frontier is null), hammering the RPC unboundedly.
      if (cacheKey && lastIngestedBlockRef.current !== null) {
        writeChartCache(cacheKey, {
          lastBlock: lastIngestedBlockRef.current,
          samples: next,
        });
      }
      return next;
    });
  }, [reservesQuery.data, reservesQuery.dataUpdatedAt, baseIsToken0, cacheKey]);

  // Filter the raw rolling buffer to the user-selected visualization window
  // (24h / 7d / 30d / all), invert if requested, then bucket into OHLC
  // candles whose width is tuned to the active window. Both transforms run
  // on the visible slice — the underlying `samples` array is never mutated.
  const { candles, latest, first, visibleCount } = useMemo(() => {
    const visible = filterSamplesToWindow(samples, windowKey, (s) => s.ts);
    const oriented: Sample[] = inverted
      ? visible.map((s) => ({ ts: s.ts, price: invertPrice(s.price) }))
      : visible;
    const built = bucketSamplesToCandles(oriented, windowKey);
    const latestC = built[built.length - 1]?.c ?? 0;
    const firstO = built[0]?.o ?? 0;
    return {
      candles: built,
      latest: latestC,
      first: firstO,
      visibleCount: oriented.length,
    };
  }, [samples, windowKey, inverted]);

  const change = latest - first;
  const changePct = first > 0 ? (change / first) * 100 : 0;
  const positive = change >= 0;

  const loading = samples.length === 0;
  const fatalError = !pairDeployed
    ? pairQuery.isError
      ? 'Pair lookup failed — RPC unreachable'
      : pairQuery.isPending
        ? null
        : `No on-chain ${baseSymbol}/${quoteSymbol} pair yet`
    : reservesQuery.isError && samples.length === 0
      ? 'Reserve read failed — RPC unreachable'
      : null;

  const headline = priceHeadline({ base: baseSymbol, quote: quoteSymbol, latest, inverted });
  const windowLabel = TIME_WINDOW_LABELS[windowKey];
  const changeSuffix = windowKey === 'all' ? 'all-time' : `vs ${windowLabel} ago`;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-white/50">
            <span>
              {inverted ? `${quoteSymbol} priced in ${baseSymbol}` : `${baseSymbol} priced in ${quoteSymbol}`}
            </span>
            <button
              type="button"
              onClick={() => setInverted((v) => !v)}
              className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] tracking-normal text-white/70 hover:bg-white/10 hover:text-white"
              title="Flip the price quote between base and quote tokens"
              aria-label="Invert price quote"
            >
              ⇄ invert
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <div className="text-2xl font-semibold tabular-nums">{headline}</div>
            <div
              className={`text-sm tabular-nums ${positive ? 'text-emerald-300' : 'text-rose-300'}`}
            >
              {visibleCount > 1 ? `${positive ? '+' : ''}${changePct.toFixed(2)}%` : '—'}{' '}
              <span className="text-white/40">· {changeSuffix} · on-chain live</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1">
            {TIME_WINDOWS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setWindowKey(k)}
                className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                  windowKey === k
                    ? 'bg-brand-accent text-brand-ink'
                    : 'text-white/70 hover:bg-white/5 hover:text-white'
                }`}
              >
                {TIME_WINDOW_LABELS[k]}
              </button>
            ))}
          </div>
          <div className="hidden rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/50 sm:block">
            {visibleCount} pt{visibleCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <BrandCandleChart
        candles={candles}
        height={320}
        priceSuffix={inverted ? baseSymbol : quoteSymbol}
        overlay={
          fatalError
            ? fatalError
            : loading
              ? `Sampling live price every ${POLL_INTERVAL_MS / 1000}s…`
              : candles.length === 0
                ? 'No on-chain samples in this window yet.'
                : null
        }
      />
    </div>
  );
}

// Bucket widths tuned to render ~96-180 candles when each window is fully
// populated. With a shorter rolling buffer the visualization simply renders
// fewer (wider-spaced) candles.
const CANDLE_INTERVAL_SECONDS: Record<TimeWindow, number> = {
  '24h': 15 * 60,
  '7d': 60 * 60,
  '30d': 4 * 60 * 60,
  all: 24 * 60 * 60,
};

function bucketSamplesToCandles(samples: Sample[], windowKey: TimeWindow): BrandCandle[] {
  if (samples.length === 0) return [];
  const intervalSec = CANDLE_INTERVAL_SECONDS[windowKey];
  const buckets = new Map<number, Sample[]>();
  for (const s of samples) {
    const bucketTs = Math.floor(s.ts / intervalSec) * intervalSec;
    let arr = buckets.get(bucketTs);
    if (!arr) {
      arr = [];
      buckets.set(bucketTs, arr);
    }
    arr.push(s);
  }
  const orderedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const out: BrandCandle[] = [];
  let lastClose: number | null = null;
  for (const bucketTs of orderedKeys) {
    const arr = buckets.get(bucketTs)!;
    arr.sort((a, b) => a.ts - b.ts);
    const open = lastClose ?? arr[0]!.price;
    let high = arr[0]!.price;
    let low = arr[0]!.price;
    for (const s of arr) {
      if (s.price > high) high = s.price;
      if (s.price < low) low = s.price;
    }
    const close = arr[arr.length - 1]!.price;
    // Stitch the previous close as this bucket's open so consecutive candles
    // join visually. Clamp the high/low band so the wick never escapes the
    // body when the stitched open jumps outside the in-bucket range.
    const effHigh = Math.max(high, open, close);
    const effLow = Math.min(low, open, close);
    out.push({ t: bucketTs, o: open, h: effHigh, l: effLow, c: close });
    lastClose = close;
  }
  return out;
}

// ---- history backfill + cache helpers -------------------------------------

type ChartCacheV1 = {
  v: typeof CACHE_SCHEMA_VERSION;
  lastBlock: string; // bigint stringified
  samples: Sample[];
};

function makeCacheKey(chainId: number, pair: Address): string {
  return `eticahub:chart:v${CACHE_SCHEMA_VERSION}:${chainId}:${pair.toLowerCase()}`;
}

function readChartCache(key: string): { lastBlock: bigint; samples: Sample[] } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChartCacheV1;
    if (parsed.v !== CACHE_SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.samples)) return null;
    return { lastBlock: BigInt(parsed.lastBlock), samples: parsed.samples };
  } catch {
    return null;
  }
}

function writeChartCache(
  key: string,
  value: { lastBlock: bigint; samples: Sample[] },
): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: ChartCacheV1 = {
      v: CACHE_SCHEMA_VERSION,
      lastBlock: value.lastBlock.toString(),
      samples: value.samples,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage unavailable — ignore; chart degrades to
    // live-only for this session.
  }
}

// Parsed Sync event descriptor — `parseAbiItem` makes viem infer `args` as
// `{ reserve0: bigint; reserve1: bigint }` on the resulting logs, which keeps
// the caller strongly typed without an unsafe cast.
const SYNC_EVENT = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');

type SyncLog = {
  blockNumber: bigint | null;
  args: { reserve0?: bigint; reserve1?: bigint };
};

async function fetchSyncLogsPaginated(
  client: PublicClient,
  pair: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<SyncLog[]> {
  const all: SyncLog[] = [];
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
        all.push({
          blockNumber: log.blockNumber ?? null,
          args: {
            reserve0: log.args.reserve0,
            reserve1: log.args.reserve1,
          },
        });
      }
      cursor = end + 1n;
    } catch (err) {
      // Shrink the range and retry; most RPC providers reject > 10k block
      // ranges or > 10k result counts. We halve until we hit the floor.
      if (pageSize <= LOGS_PAGE_BLOCKS_MIN) throw err;
      pageSize = pageSize / 2n;
      if (pageSize < LOGS_PAGE_BLOCKS_MIN) pageSize = LOGS_PAGE_BLOCKS_MIN;
    }
  }
  return all;
}
