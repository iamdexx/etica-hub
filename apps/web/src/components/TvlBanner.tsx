'use client';

/**
 * Prominent live-updating TVL banner surfaced above the swap card.
 *
 * Hits `/api/v1/tvl` every 15 seconds (matching the route's edge cache
 * window), rendering both the USD headline and the ETX-denominated figure
 * so users can see how much liquidity the DEX holds without leaving the
 * page. When USD is unavailable (NonKYC unreachable or no anchor pool has
 * liquidity) we fall back to showing the ETX figure alone — never a stale
 * or fabricated dollar number.
 *
 * The card is deliberately loud — gradient border, large type, animated
 * live-indicator — because it's the primary "is the protocol breathing?"
 * signal on the swap surface.
 */

import { useEffect, useState } from 'react';

interface TvlResponse {
  asOf: string;
  etxUsd: number | null;
  tvl: {
    etx: number;
    usd: number | null;
  };
  poolCount: number;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: TvlResponse; stale: boolean }
  | { status: 'error'; error: string };

/** Poll interval. Matches the `/api/v1/tvl` route revalidate window. */
const POLL_INTERVAL_MS = 15_000;

export function useLiveTvl(): State {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const load = async (isRefresh: boolean) => {
      try {
        const res = await fetch('/api/v1/tvl', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as TvlResponse;
        if (!cancelled) setState({ status: 'ready', data, stale: false });
      } catch (err) {
        if (cancelled) return;
        // On a refresh failure, keep showing the last good number but flag
        // it stale rather than flashing an error. First-load failures get
        // an explicit error state.
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
  }, []);
  return state;
}

function formatUsdHeadline(n: number): string {
  // Keep two fractional digits for sub-$100 values (precision matters while
  // ETX is still in sub-cent territory), otherwise cut to whole dollars.
  if (n < 100) {
    return `$${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (n < 1_000_000) {
    return `$${Math.round(n).toLocaleString()}`;
  }
  if (n < 1_000_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${(n / 1_000_000_000).toFixed(2)}B`;
}

function formatEtxAmount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B ETX`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M ETX`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k ETX`;
  return `${n.toFixed(2)} ETX`;
}

export function TvlBanner(props: { className?: string }) {
  const state = useLiveTvl();

  const shell =
    'relative overflow-hidden rounded-2xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-white/5 to-cyan-500/10 p-5 shadow-[0_0_40px_-12px_rgba(16,185,129,0.4)]';

  if (state.status === 'loading') {
    return (
      <div className={`${shell} ${props.className ?? ''}`}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest text-emerald-300/80">
            Total Value Locked
          </span>
          <span className="text-xs text-white/40">loading…</span>
        </div>
        <div className="mt-2 h-9 w-40 animate-pulse rounded bg-white/10" />
        <div className="mt-2 h-4 w-28 animate-pulse rounded bg-white/5" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={`${shell} ${props.className ?? ''}`}>
        <div className="text-xs font-semibold uppercase tracking-widest text-emerald-300/80">
          Total Value Locked
        </div>
        <div className="mt-2 text-sm text-red-300/80">
          Couldn&apos;t load TVL: {state.error}
        </div>
      </div>
    );
  }

  const { data, stale } = state;
  const headline =
    data.tvl.usd !== null ? formatUsdHeadline(data.tvl.usd) : formatEtxAmount(data.tvl.etx);
  const sub =
    data.tvl.usd !== null
      ? formatEtxAmount(data.tvl.etx)
      : 'USD unavailable (oracle offline)';

  return (
    <div className={`${shell} ${props.className ?? ''}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-emerald-300/80">
          Total Value Locked
        </span>
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/40">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              stale ? 'bg-yellow-400' : 'animate-pulse bg-emerald-400'
            }`}
            aria-hidden
          />
          {stale ? 'stale' : 'live'}
        </span>
      </div>
      <div
        className="mt-1 bg-gradient-to-r from-emerald-200 to-cyan-200 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl"
        aria-live="polite"
      >
        {headline}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-white/50">
        <span>{sub}</span>
        <span>
          {data.poolCount} pool{data.poolCount === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}
