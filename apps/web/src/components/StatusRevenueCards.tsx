'use client';

/**
 * Live revenue + liquidity-flow cards surfaced on /status.
 *
 * Two cards driven off `/api/v1/revenue` and `/api/v1/liquidity-flow`. The
 * API routes already cache at 60s edge ISR, so polling every 60s here
 * typically hits the CDN warm-cache — no additional load on the RPC.
 *
 * Revenue card surfaces:
 *   - Lifetime swap count + ETX/USD volume
 *   - LP fees (0.30%) — context; paid to LPs, not protocol
 *   - Accrued protocol fee (0.05%) = theoretical LP slice at feeTo
 *   - Realized = actual ETX pulled out via `pair.burn(feeTo)` — can be 0
 *     if the treasury hasn't redeemed yet, or diverge from accrued once
 *     redemptions fire.
 *
 * Liquidity-flow card surfaces:
 *   - Lifetime Mint/Burn counts + ETX totals
 *   - Net flow = added − removed (negative when burns outpace mints,
 *     e.g. the treasury unpairs to realize revenue)
 *   - Current TVL for reconciliation
 *
 * Stale-on-error behavior mirrors TvlBanner: a transient refresh failure
 * keeps the last-good numbers visible with a stale indicator rather than
 * flashing an error.
 */

import { useEffect, useState } from 'react';

interface RevenuePool {
  pool: string;
  pairSymbol: string | null;
  swapCount: number;
  volumeEtx: number;
  volumeUsd: number | null;
  accruedProtocolFeeEtx: number;
  accruedProtocolFeeUsd: number | null;
  realizedBurnCount: number;
  realizedEtx: number;
  realizedEtxUsd: number | null;
}

interface HarvestSummary {
  address: string;
  runCount: number;
  totalEtxHarvested: number;
  totalEtxHarvestedUsd: number | null;
  stakedSliceEtx: number;
  stakedSliceUsd: number | null;
  farmsSliceEtx: number;
  farmsSliceUsd: number | null;
  polSliceEtx: number;
  polSliceUsd: number | null;
  treasurySliceEtx: number;
  treasurySliceUsd: number | null;
}

interface RevenueResponse {
  asOf: string;
  etxUsd: number | null;
  feeTo: string | null;
  feeToActive: boolean;
  totals: {
    swapCount: number;
    volumeEtx: number;
    volumeUsd: number | null;
    lpFeeEtx: number;
    lpFeeUsd: number | null;
    accruedProtocolFeeEtx: number;
    accruedProtocolFeeUsd: number | null;
    realizedEtx: number;
    realizedEtxUsd: number | null;
    realizedEtxFromFeeTo: number;
    realizedEtxFromFeeToUsd: number | null;
  };
  harvest: HarvestSummary;
  poolCount: number;
  pools: RevenuePool[];
}

interface LiquidityFlowPool {
  pool: string;
  pairSymbol: string | null;
  mintCount: number;
  addedEtx: number;
  burnCount: number;
  removedEtx: number;
  netEtx: number;
  netUsd: number | null;
  currentTvlEtx: number;
  currentTvlUsd: number | null;
}

interface LiquidityFlowResponse {
  asOf: string;
  etxUsd: number | null;
  totals: {
    mintCount: number;
    addedEtx: number;
    addedUsd: number | null;
    burnCount: number;
    removedEtx: number;
    removedUsd: number | null;
    netFlowEtx: number;
    netFlowUsd: number | null;
    currentTvlEtx: number;
    currentTvlUsd: number | null;
  };
  poolCount: number;
  pools: LiquidityFlowPool[];
}

type Fetched<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; stale: boolean }
  | { status: 'error'; error: string };

/** Matches the routes' 60s ISR window so we typically hit warm CDN cache. */
const POLL_INTERVAL_MS = 60_000;

function useLiveJson<T>(url: string): Fetched<T> {
  const [state, setState] = useState<Fetched<T>>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const load = async (isRefresh: boolean) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as T;
        if (!cancelled) setState({ status: 'ready', data, stale: false });
      } catch (err) {
        if (cancelled) return;
        setState((prev) =>
          isRefresh && prev.status === 'ready'
            ? { status: 'ready', data: prev.data, stale: true }
            : { status: 'error', error: (err as Error).message },
        );
      }
    };
    void load(false);
    const interval = setInterval(() => void load(true), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [url]);
  return state;
}

function formatUsd(n: number | null): string {
  if (n === null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 100) {
    return `${sign}$${abs.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (abs < 1_000_000) return `${sign}$${Math.round(abs).toLocaleString()}`;
  if (abs < 1_000_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
}

function formatEtx(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000)
    return `${sign}${(abs / 1_000_000_000).toFixed(2)}B ETX`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M ETX`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}k ETX`;
  return `${sign}${abs.toFixed(2)} ETX`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function CardShell(props: {
  title: string;
  stale?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/70">{props.title}</h2>
        <span className="text-[10px] uppercase tracking-wider text-white/40">
          {props.loading
            ? 'loading…'
            : props.stale
              ? 'cached (refresh failed)'
              : 'live'}
        </span>
      </div>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-white/50">
        {props.label}
        {props.hint ? (
          <span className="ml-1 text-[10px] text-white/30">({props.hint})</span>
        ) : null}
      </dt>
      <dd className="font-mono text-white/85">{props.value}</dd>
    </div>
  );
}

export function StatusRevenueCard() {
  const state = useLiveJson<RevenueResponse>('/api/v1/revenue');

  if (state.status === 'loading') {
    return (
      <CardShell title="Protocol revenue (since launch)" loading>
        <div className="space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-white/10" />
          <div className="h-4 w-28 animate-pulse rounded bg-white/5" />
          <div className="h-4 w-32 animate-pulse rounded bg-white/5" />
        </div>
      </CardShell>
    );
  }
  if (state.status === 'error') {
    return (
      <CardShell title="Protocol revenue (since launch)">
        <p className="text-sm text-rose-300/80">
          Couldn&apos;t load revenue: {state.error}
        </p>
      </CardShell>
    );
  }

  const { data, stale } = state;
  const t = data.totals;
  return (
    <CardShell title="Protocol revenue (since launch)" stale={stale}>
      <dl className="space-y-1">
        <Row
          label="Volume"
          value={`${formatEtx(t.volumeEtx)} · ${formatUsd(t.volumeUsd)}`}
          hint={`${t.swapCount} swaps`}
        />
        <Row
          label="LP fees (0.30%)"
          value={`${formatEtx(t.lpFeeEtx)} · ${formatUsd(t.lpFeeUsd)}`}
          hint="paid to LPs"
        />
        <Row
          label="Protocol fee accrued (0.05%)"
          value={`${formatEtx(t.accruedProtocolFeeEtx)} · ${formatUsd(t.accruedProtocolFeeUsd)}`}
          hint={data.feeToActive ? 'unredeemed LP at feeTo' : 'feeTo disabled'}
        />
        <Row
          label="Protocol fee realized"
          value={`${formatEtx(t.realizedEtx)} · ${formatUsd(t.realizedEtxUsd)}`}
          hint="feeTo burns + harvester output"
        />
      </dl>

      {data.harvest.runCount > 0 ? (
        <div className="mt-3 border-t border-white/5 pt-3">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-white/40">
            Harvester ({data.harvest.runCount} run
            {data.harvest.runCount === 1 ? '' : 's'})
          </h3>
          <dl className="space-y-1">
            <Row
              label="Total harvested"
              value={`${formatEtx(data.harvest.totalEtxHarvested)} · ${formatUsd(data.harvest.totalEtxHarvestedUsd)}`}
              hint="sum of all runs"
            />
            <Row
              label="→ Treasury"
              value={`${formatEtx(data.harvest.treasurySliceEtx)} · ${formatUsd(data.harvest.treasurySliceUsd)}`}
              hint="40%"
            />
            <Row
              label="→ stETX yield"
              value={`${formatEtx(data.harvest.stakedSliceEtx)} · ${formatUsd(data.harvest.stakedSliceUsd)}`}
              hint="10%"
            />
            <Row
              label="→ ETXFarms"
              value={`${formatEtx(data.harvest.farmsSliceEtx)} · ${formatUsd(data.harvest.farmsSliceUsd)}`}
              hint="10%"
            />
            <Row
              label="→ POL burn"
              value={`${formatEtx(data.harvest.polSliceEtx)} · ${formatUsd(data.harvest.polSliceUsd)}`}
              hint="40% LP to 0xdead"
            />
          </dl>
        </div>
      ) : null}

      {data.pools.length > 0 ? (
        <div className="mt-3 border-t border-white/5 pt-3">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-white/40">
            Per pool
          </h3>
          <dl className="space-y-1">
            {data.pools.map((p) => (
              <Row
                key={p.pool}
                label={p.pairSymbol ?? shortAddr(p.pool)}
                value={`${formatUsd(p.volumeUsd)} vol · acc ${formatUsd(p.accruedProtocolFeeUsd)} · real ${formatUsd(p.realizedEtxUsd)}`}
              />
            ))}
          </dl>
        </div>
      ) : null}

      {data.feeTo ? (
        <p className="mt-3 text-[11px] text-white/40">
          feeTo: <span className="font-mono">{shortAddr(data.feeTo)}</span>
          {data.harvest.runCount > 0 ? (
            <>
              {' '}· harvester:{' '}
              <span className="font-mono">
                {shortAddr(data.harvest.address)}
              </span>
            </>
          ) : null}
          . Realized = ETX redeemed via{' '}
          <span className="font-mono">pair.burn(feeTo)</span> plus{' '}
          <span className="font-mono">HarvestExecuted.totalEtxHarvested</span>.
        </p>
      ) : null}
    </CardShell>
  );
}

export function StatusLiquidityFlowCard() {
  const state = useLiveJson<LiquidityFlowResponse>('/api/v1/liquidity-flow');

  if (state.status === 'loading') {
    return (
      <CardShell title="Liquidity flow (since launch)" loading>
        <div className="space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-white/10" />
          <div className="h-4 w-28 animate-pulse rounded bg-white/5" />
          <div className="h-4 w-32 animate-pulse rounded bg-white/5" />
        </div>
      </CardShell>
    );
  }
  if (state.status === 'error') {
    return (
      <CardShell title="Liquidity flow (since launch)">
        <p className="text-sm text-rose-300/80">
          Couldn&apos;t load liquidity flow: {state.error}
        </p>
      </CardShell>
    );
  }

  const { data, stale } = state;
  const t = data.totals;
  const netNegative = t.netFlowEtx < 0;
  const netColor = netNegative ? 'text-rose-300' : 'text-emerald-300';

  return (
    <CardShell title="Liquidity flow (since launch)" stale={stale}>
      <dl className="space-y-1">
        <Row
          label="Added"
          value={`${formatEtx(t.addedEtx)} · ${formatUsd(t.addedUsd)}`}
          hint={`${t.mintCount} Mint events`}
        />
        <Row
          label="Removed"
          value={`${formatEtx(t.removedEtx)} · ${formatUsd(t.removedUsd)}`}
          hint={`${t.burnCount} Burn events`}
        />
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <dt className="text-white/50">Net flow</dt>
          <dd className={`font-mono ${netColor}`}>
            {formatEtx(t.netFlowEtx)} · {formatUsd(t.netFlowUsd)}
          </dd>
        </div>
        <Row
          label="Current TVL"
          value={`${formatEtx(t.currentTvlEtx)} · ${formatUsd(t.currentTvlUsd)}`}
          hint="spot × 2 on ETX reserve"
        />
      </dl>

      {data.pools.length > 0 ? (
        <div className="mt-3 border-t border-white/5 pt-3">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-white/40">
            Per pool · net flow
          </h3>
          <dl className="space-y-1">
            {data.pools.map((p) => {
              const poolNegative = p.netEtx < 0;
              return (
                <div
                  key={p.pool}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <dt className="text-white/50">
                    {p.pairSymbol ?? shortAddr(p.pool)}
                    <span className="ml-1 text-[10px] text-white/30">
                      ({p.mintCount}m / {p.burnCount}b)
                    </span>
                  </dt>
                  <dd
                    className={`font-mono ${poolNegative ? 'text-rose-300' : 'text-white/85'}`}
                  >
                    {formatEtx(p.netEtx)} · {formatUsd(p.netUsd)}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : null}

      <p className="mt-3 text-[11px] text-white/40">
        Net flow goes negative when Burn events outpace Mint events (e.g.
        treasury unpairs to realize revenue, LPs exit). TVL change with
        net-flow ≈ 0 is pure price movement on the ETX leg.
      </p>
    </CardShell>
  );
}
