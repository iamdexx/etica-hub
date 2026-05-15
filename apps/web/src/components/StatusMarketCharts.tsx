'use client';

import { useEffect, useMemo, useState } from 'react';
import { MarketChartShell, MarketPill, TimeframePills } from '@/components/MarketChartShell';

interface RevenuePool {
  pool: string;
  pairSymbol: string | null;
  volumeUsd: number | null;
  accruedProtocolFeeUsd: number | null;
  realizedEtxUsd: number | null;
}

interface RevenueResponse {
  totals: {
    volumeUsd: number | null;
    lpFeeUsd: number | null;
    accruedProtocolFeeUsd: number | null;
    realizedEtxUsd: number | null;
  };
  pools: RevenuePool[];
}

interface LiquidityFlowPool {
  pool: string;
  pairSymbol: string | null;
  addedUsd: number | null;
  removedUsd: number | null;
  netUsd: number | null;
  currentTvlUsd: number | null;
}

interface LiquidityFlowResponse {
  totals: {
    addedUsd: number | null;
    removedUsd: number | null;
    netFlowUsd: number | null;
    currentTvlUsd: number | null;
  };
  pools: LiquidityFlowPool[];
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: string };

function useJson<T>(url: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as T;
        if (!cancelled) setState({ status: 'ready', data });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', error: error instanceof Error ? error.message : 'Failed to load' });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

function usd(value: number | null | undefined): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function StatusMarketCharts() {
  const revenue = useJson<RevenueResponse>('/api/v1/revenue');
  const liquidity = useJson<LiquidityFlowResponse>('/api/v1/liquidity-flow');

  if (revenue.status === 'loading' || liquidity.status === 'loading') {
    return (
      <MarketChartShell eyebrow="Market analytics" title="EticaHub liquidity and revenue charts" actions={<TimeframePills active="24H" />}>
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <div className="h-56 animate-pulse rounded-lg bg-white/[0.04]" />
          <div className="h-56 animate-pulse rounded-lg bg-white/[0.04]" />
        </div>
      </MarketChartShell>
    );
  }

  if (revenue.status === 'error' || liquidity.status === 'error') {
    return (
      <section className="rounded-xl border border-rose-400/20 bg-rose-400/10 p-5 text-sm text-rose-200">
        Could not load market charts.
      </section>
    );
  }

  return (
    <MarketChartShell
      eyebrow="Market analytics"
      title="EticaHub liquidity and revenue charts"
      subtitle="Live on-chain fee, volume, TVL, and LP-flow distribution."
      actions={
        <>
          <TimeframePills active="24H" />
          <MarketPill tone="green">Volume {usd(revenue.data.totals.volumeUsd)}</MarketPill>
          <MarketPill>TVL {usd(liquidity.data.totals.currentTvlUsd)}</MarketPill>
        </>
      }
    >
      <div className="grid gap-0 md:grid-cols-2">
        <RevenueBars pools={revenue.data.pools} totals={revenue.data.totals} />
        <LiquidityBars pools={liquidity.data.pools} totals={liquidity.data.totals} />
      </div>
    </MarketChartShell>
  );
}

function RevenueBars({ pools, totals }: { pools: RevenuePool[]; totals: RevenueResponse['totals'] }) {
  const rows = useMemo(() => {
    const sorted = [...pools].sort((a, b) => (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0)).slice(0, 7);
    const max = Math.max(1, ...sorted.map((pool) => pool.volumeUsd ?? 0));
    return sorted.map((pool) => ({
      label: pool.pairSymbol ?? shortAddress(pool.pool),
      volume: pool.volumeUsd ?? 0,
      fee: pool.accruedProtocolFeeUsd ?? 0,
      realized: pool.realizedEtxUsd ?? 0,
      pct: ((pool.volumeUsd ?? 0) / max) * 100,
    }));
  }, [pools]);

  return (
    <div className="border-white/10 p-4 md:border-r">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/40">Revenue by pool</div>
          <div className="mt-1 text-lg font-semibold text-white">{usd(totals.volumeUsd)}</div>
        </div>
        <div className="text-right text-[11px] text-white/45">
          <div>LP fees {usd(totals.lpFeeUsd)}</div>
          <div>Protocol {usd(totals.accruedProtocolFeeUsd)}</div>
        </div>
      </div>

      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-white/65">{row.label}</span>
              <span className="font-mono text-white/50">{usd(row.volume)}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-500/35 via-emerald-300/70 to-lime-300/85" style={{ width: `${Math.max(2, row.pct)}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-white/35">
              <span>accrued {usd(row.fee)}</span>
              <span>realized {usd(row.realized)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiquidityBars({ pools, totals }: { pools: LiquidityFlowPool[]; totals: LiquidityFlowResponse['totals'] }) {
  const rows = useMemo(() => {
    const sorted = [...pools].sort((a, b) => Math.abs(b.netUsd ?? 0) - Math.abs(a.netUsd ?? 0)).slice(0, 7);
    const max = Math.max(1, ...sorted.map((pool) => Math.abs(pool.netUsd ?? 0)));
    return sorted.map((pool) => ({
      label: pool.pairSymbol ?? shortAddress(pool.pool),
      added: pool.addedUsd ?? 0,
      removed: pool.removedUsd ?? 0,
      net: pool.netUsd ?? 0,
      tvl: pool.currentTvlUsd ?? 0,
      pct: (Math.abs(pool.netUsd ?? 0) / max) * 50,
    }));
  }, [pools]);

  return (
    <div className="p-4">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/40">Liquidity flow</div>
          <div className={`mt-1 text-lg font-semibold ${totals.netFlowUsd && totals.netFlowUsd < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{usd(totals.netFlowUsd)}</div>
        </div>
        <div className="text-right text-[11px] text-white/45">
          <div>Added {usd(totals.addedUsd)}</div>
          <div>Removed {usd(totals.removedUsd)}</div>
        </div>
      </div>
      <div className="space-y-3">
        {rows.map((row) => {
          const positive = row.net >= 0;
          return (
            <div key={row.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-white/65">{row.label}</span>
                <span className={`font-mono ${positive ? 'text-emerald-300/80' : 'text-rose-300/80'}`}>{usd(row.net)}</span>
              </div>
              <div className="relative h-4 rounded-full bg-white/[0.055]">
                <div className="absolute left-1/2 top-0 h-full w-px bg-white/20" />
                <div className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-full ${positive ? 'left-1/2 bg-emerald-300/75' : 'right-1/2 bg-rose-300/75'}`} style={{ width: `${Math.max(2, row.pct)}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-white/35">
                <span>added {usd(row.added)}</span>
                <span>TVL {usd(row.tvl)}</span>
                <span>removed {usd(row.removed)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
