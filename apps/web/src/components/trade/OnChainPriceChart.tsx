'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatUnits, parseAbiItem, type Address, type PublicClient } from 'viem';
import { useChainId, usePublicClient, useReadContract } from 'wagmi';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';

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
  baseSymbol: 'ETI' | 'EGAZ';
  quoteSymbol: string;
}

export function OnChainPriceChart({ baseSymbol, quoteSymbol }: OnChainPriceChartProps) {
  const chainId = useChainId();
  const deployment = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS];
  const external = EXTERNAL_ADDRESSES[chainId as keyof typeof EXTERNAL_ADDRESSES];

  const baseAddress: Address | undefined = baseSymbol === 'ETI' ? external?.eti : deployment?.wegaz;
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
  const [lastIngestedBlock, setLastIngestedBlock] = useState<bigint | null>(null);
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
  useEffect(() => {
    if (!cacheKey) {
      setSamples([]);
      setLastIngestedBlock(null);
      return;
    }
    const cached = readChartCache(cacheKey);
    if (cached) {
      setSamples(cached.samples);
      setLastIngestedBlock(cached.lastBlock);
    } else {
      setSamples([]);
      setLastIngestedBlock(null);
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
        const fromBlock =
          lastIngestedBlock !== null
            ? lastIngestedBlock + 1n
            : headNumber > HISTORY_BACKFILL_BLOCKS
              ? headNumber - HISTORY_BACKFILL_BLOCKS
              : 0n;
        if (fromBlock > headNumber) return;
        const logs = await fetchSyncLogsPaginated(publicClient, pair, fromBlock, headNumber);
        if (cancelled || logs.length === 0) {
          // Still advance the frontier so we don't re-scan an empty range
          // every mount.
          if (!cancelled) {
            setLastIngestedBlock(headNumber);
            writeChartCache(cacheKey, { lastBlock: headNumber, samples });
          }
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
        setLastIngestedBlock(headNumber);
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
      if (cacheKey) {
        writeChartCache(cacheKey, {
          lastBlock: lastIngestedBlock ?? 0n,
          samples: next,
        });
      }
      return next;
    });
  }, [reservesQuery.data, reservesQuery.dataUpdatedAt, baseIsToken0, cacheKey, lastIngestedBlock]);

  const { pathD, areaD, minP, maxP, latest, first } = useMemo(
    () => buildSvg(samples.map((s) => s.price)),
    [samples],
  );

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

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-white/50">
            {baseSymbol} / {quoteSymbol}
          </div>
          <div className="flex items-baseline gap-3">
            <div className="text-2xl font-semibold tabular-nums">{formatPrice(latest)}</div>
            <div
              className={`text-sm tabular-nums ${positive ? 'text-emerald-300' : 'text-rose-300'}`}
            >
              {samples.length > 1 ? `${positive ? '+' : ''}${changePct.toFixed(2)}%` : '—'} ·
              on-chain live
            </div>
          </div>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/50">
          {samples.length} sample{samples.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox="0 0 600 200"
          preserveAspectRatio="none"
          className="h-56 w-full"
          role="img"
          aria-label={`${baseSymbol}/${quoteSymbol} on-chain price chart`}
        >
          <defs>
            <linearGradient id="onchain-chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          {pathD && (
            <>
              <path
                d={areaD}
                fill="url(#onchain-chart-fill)"
                className={positive ? 'text-emerald-400' : 'text-rose-400'}
              />
              <path
                d={pathD}
                fill="none"
                strokeWidth="1.5"
                stroke="currentColor"
                className={positive ? 'text-emerald-300' : 'text-rose-300'}
              />
            </>
          )}
        </svg>

        {(fatalError || loading) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-full border border-white/10 bg-black/60 px-3 py-1 text-xs text-white/60">
              {fatalError ?? `Sampling live price every ${POLL_INTERVAL_MS / 1000}s…`}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex justify-between text-xs tabular-nums text-white/50">
        <span>Low {formatPrice(minP)}</span>
        <span>
          {samples.length > 0
            ? `${fmtClock(samples[0]!.ts)} → ${fmtClock(samples[samples.length - 1]!.ts)}`
            : ''}
        </span>
        <span>High {formatPrice(maxP)}</span>
      </div>
    </div>
  );
}

function buildSvg(closes: number[]) {
  const empty = { pathD: '', areaD: '', minP: 0, maxP: 0, latest: 0, first: 0 };
  if (closes.length === 0) return empty;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || max || 1;
  const W = 600;
  const H = 200;
  const padX = 8;
  const padY = 12;
  const usableW = W - padX * 2;
  const usableH = H - padY * 2;
  const n = closes.length;
  const points = closes.map((v, i) => {
    const x = padX + (usableW * i) / Math.max(1, n - 1);
    const y = padY + usableH - ((v - min) / span) * usableH;
    return [x, y] as const;
  });
  const pathD = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');
  const [firstX] = points[0]!;
  const [lastX] = points[points.length - 1]!;
  const areaD = `${pathD} L${lastX.toFixed(2)} ${(padY + usableH).toFixed(
    2,
  )} L${firstX.toFixed(2)} ${(padY + usableH).toFixed(2)} Z`;
  return {
    pathD,
    areaD,
    minP: min,
    maxP: max,
    latest: closes[closes.length - 1] ?? 0,
    first: closes[0] ?? 0,
  };
}

function formatPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
