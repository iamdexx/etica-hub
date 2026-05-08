'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  formatPriceRatio,
  invertPrice,
  priceHeadline,
} from '@/lib/trading/priceLabel';

/**
 * Candle shape returned by the indexer's `/prices/:pairId/candles` endpoint.
 * All numeric fields are 1e18-scaled integers encoded as decimal strings to
 * avoid float precision loss for 18-decimal tokens.
 */
type Candle = {
  bucketStart: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeBase: string;
  volumeQuote: string;
  tradeCount: number;
};

export type IntervalKey = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
const INTERVALS: IntervalKey[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

function pxFromString18(s: string): number {
  // Lossy for rendering only — BigInt math is preserved upstream for storage.
  return Number(s) / 1e18;
}

function fmtTime(ts: number, interval: IntervalKey): string {
  const d = new Date(ts * 1000);
  if (interval === '1d' || interval === '4h') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface PriceChartProps {
  pairId: string;
  baseSymbol: string;
  quoteSymbol: string;
  apiBaseUrl: string;
}

export function PriceChart({ pairId, baseSymbol, quoteSymbol, apiBaseUrl }: PriceChartProps) {
  const [interval, setIntervalState] = useState<IntervalKey>('1h');
  const [inverted, setInverted] = useState(false);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const url = `${apiBaseUrl.replace(/\/$/, '')}/prices/${encodeURIComponent(
      pairId,
    )}/candles?interval=${interval}&limit=240`;
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ candles: Candle[] }>;
      })
      .then((j) => {
        if (cancelled) return;
        setCandles(j.candles ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'fetch failed');
        setCandles(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pairId, interval, apiBaseUrl]);

  const { pathD, areaD, minP, maxP, latest, first } = useMemo(() => {
    const empty = {
      pathD: '',
      areaD: '',
      minP: 0,
      maxP: 0,
      latest: 0,
      first: 0,
    };
    if (!candles || candles.length === 0) return empty;
    const rawCloses = candles.map((c) => pxFromString18(c.close));
    const closes = inverted ? rawCloses.map(invertPrice) : rawCloses;
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
  }, [candles, inverted]);

  const change = latest - first;
  const changePct = first > 0 ? (change / first) * 100 : 0;
  const positive = change >= 0;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-white/50">
            <span>
              {inverted
                ? `${quoteSymbol} priced in ${baseSymbol}`
                : `${baseSymbol} priced in ${quoteSymbol}`}
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
            <div className="text-2xl font-semibold tabular-nums">
              {priceHeadline({ base: baseSymbol, quote: quoteSymbol, latest, inverted })}
            </div>
            <div
              className={`text-sm tabular-nums ${positive ? 'text-emerald-300' : 'text-rose-300'}`}
            >
              {positive ? '+' : ''}
              {changePct.toFixed(2)}% <span className="text-white/40">· {interval}</span>
            </div>
          </div>
        </div>
        <div className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1">
          {INTERVALS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setIntervalState(k)}
              className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                interval === k
                  ? 'bg-brand-accent text-brand-ink'
                  : 'text-white/70 hover:bg-white/5 hover:text-white'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox="0 0 600 200"
          preserveAspectRatio="none"
          className="h-56 w-full"
          role="img"
          aria-label={`${baseSymbol}/${quoteSymbol} price chart`}
        >
          <defs>
            <linearGradient id="trade-chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          {pathD && (
            <>
              <path
                d={areaD}
                fill="url(#trade-chart-fill)"
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

        {(loading || err || !candles || candles.length === 0) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-full border border-white/10 bg-black/60 px-3 py-1 text-xs text-white/60">
              {loading
                ? 'Loading price history…'
                : err
                  ? `Price feed unavailable (${err})`
                  : 'No price history yet'}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex justify-between text-xs tabular-nums text-white/50">
        <span>Low {formatPriceRatio(minP)}</span>
        <span>
          {candles && candles.length > 0
            ? `${fmtTime(candles[0]!.bucketStart, interval)} → ${fmtTime(
                candles[candles.length - 1]!.bucketStart,
                interval,
              )}`
            : ''}
        </span>
        <span>High {formatPriceRatio(maxP)}</span>
      </div>
    </div>
  );
}
