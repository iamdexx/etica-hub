'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { useChainId, useReadContract } from 'wagmi';
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
// Rolling buffer size. 240 samples × 8s ≈ 32 minutes of live history.
const MAX_SAMPLES = 240;

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
    setSamples((prev) => {
      const next = [...prev, { ts: Math.floor(Date.now() / 1000), price }];
      if (next.length > MAX_SAMPLES) next.splice(0, next.length - MAX_SAMPLES);
      return next;
    });
  }, [reservesQuery.data, reservesQuery.dataUpdatedAt, baseIsToken0]);

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
