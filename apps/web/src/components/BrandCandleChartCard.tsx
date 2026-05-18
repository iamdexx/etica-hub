'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrandCandleChart, type BrandCandle } from './BrandCandleChart';

/**
 * Wrapper card that pairs `BrandCandleChart` with working timeframe pills
 * and a live fetch against `/api/v1/ohlcv/{pair}`. Used by the explorer
 * pair/token surfaces and any future drill-down that wants a real candle
 * chart with zero glue code at the call site.
 */
export type OhlcvInterval = '5m' | '15m' | '1h' | '4h' | '1d';

const INTERVALS: readonly { key: OhlcvInterval; label: string; limit: number }[] = [
  { key: '5m', label: '5m', limit: 144 },
  { key: '15m', label: '15m', limit: 192 },
  { key: '1h', label: '1h', limit: 168 },
  { key: '4h', label: '4h', limit: 180 },
  { key: '1d', label: '1d', limit: 180 },
];

interface ApiCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  samples?: number;
}

interface OhlcvResponse {
  candles: ApiCandle[];
  base: string;
  quote: string;
  intervalSeconds: number;
}

export interface BrandCandleChartCardProps {
  /** Pool address on EticaSwap V2. */
  pair: `0x${string}`;
  /** Visible card header (small uppercase line above title). */
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** Default selected interval. Falls through to 1h. */
  defaultInterval?: OhlcvInterval;
  /** Custom child rendered to the right of the timeframe pills. */
  rightActions?: ReactNode;
  /** Content rendered under the chart (depth cards etc). */
  footer?: ReactNode;
  /** Show base+quote symbols inside the chart instead of the price-suffix.
   *  Default true. */
  showLegend?: boolean;
  /** Override displayed base symbol (e.g. "stETX"). When omitted, uses the
   *  base id returned by the API. */
  baseSymbol?: string;
  /** Override displayed quote symbol. Default "ETX" via API. */
  quoteSymbol?: string;
}

export function BrandCandleChartCard({
  pair,
  eyebrow,
  title,
  subtitle,
  defaultInterval = '1h',
  rightActions,
  footer,
  showLegend = true,
  baseSymbol,
  quoteSymbol,
}: BrandCandleChartCardProps) {
  const [interval, setIntervalKey] = useState<OhlcvInterval>(defaultInterval);
  const [data, setData] = useState<OhlcvResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const limit = INTERVALS.find((i) => i.key === interval)?.limit ?? 168;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/ohlcv/${pair}?interval=${interval}&limit=${limit}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}${body ? ` — ${body.slice(0, 80)}` : ''}`);
        }
        return r.json() as Promise<OhlcvResponse>;
      })
      .then((j) => {
        if (cancelled) return;
        setData(j);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load candles');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pair, interval]);

  const candles = useMemo<BrandCandle[]>(() => {
    if (!data) return [];
    return data.candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
  }, [data]);

  const display = useMemo(() => {
    const base = (baseSymbol ?? data?.base ?? '').toUpperCase();
    const quote = (quoteSymbol ?? data?.quote ?? 'ETX').toUpperCase();
    return { base, quote };
  }, [data, baseSymbol, quoteSymbol]);

  const latest = candles[candles.length - 1] ?? null;
  const first = candles[0] ?? null;
  const change = latest && first ? latest.c - first.o : 0;
  const changePct = latest && first && first.o > 0 ? (change / first.o) * 100 : 0;
  const positive = change >= 0;

  const overlay = error
    ? error
    : loading && candles.length === 0
      ? 'Loading candles…'
      : candles.length === 0
        ? `No on-chain trades in the last ${interval}.`
        : null;

  return (
    <section className="overflow-hidden rounded-xl border border-white/10 bg-[#06110e] shadow-2xl shadow-emerald-950/10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/70">{eyebrow}</div>
          <h2 className="mt-1 text-sm font-semibold text-white">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-white/45">{subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {showLegend && display.base ? (
            <div className="flex items-baseline gap-2 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono">
              <span className="text-white/55">
                {display.base}/{display.quote}
              </span>
              {latest ? (
                <>
                  <span className="text-white tabular-nums">{latest.c.toFixed(latest.c >= 1 ? 4 : 6)}</span>
                  <span
                    className={`tabular-nums ${positive ? 'text-emerald-300' : 'text-rose-300'}`}
                  >
                    {Number.isFinite(changePct)
                      ? `${positive ? '+' : ''}${changePct.toFixed(2)}%`
                      : ''}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="flex rounded-md border border-white/10 bg-black/30 p-1">
            {INTERVALS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setIntervalKey(opt.key)}
                aria-pressed={opt.key === interval}
                className={`rounded px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                  opt.key === interval
                    ? 'bg-brand-accent text-brand-ink'
                    : 'text-white/55 hover:bg-white/5 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {rightActions}
        </div>
      </div>
      <div className="px-2 pb-2 pt-2 sm:px-3">
        <BrandCandleChart candles={candles} overlay={overlay} />
      </div>
      {footer ? <div className="border-t border-white/10">{footer}</div> : null}
    </section>
  );
}
