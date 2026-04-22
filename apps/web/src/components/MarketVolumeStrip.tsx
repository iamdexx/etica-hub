'use client';

/**
 * Cross-page "24h volume" strip, shown above /swap, /pool, and /trade
 * so users can see market activity at a glance without drilling into a
 * specific pool.
 *
 * Reads `/api/v1/pools`, which carries `volume_24h` per pool (gross
 * turnover for each side of the pair + swap count). One row per pool,
 * headline amount denominated in ETX (the hub token), with the non-ETX
 * leg shown alongside for context.
 */

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { formatShortAmount } from './PairVolume24h';

interface PoolEntry {
  pool_address: Address;
  base: {
    symbol: string | null;
    address: Address;
    decimals: number | null;
  };
  quote: {
    symbol: string | null;
    address: Address;
    decimals: number | null;
  };
  volume_24h: {
    base: string;
    quote: string;
    swap_count: number;
    from_timestamp: number;
    to_timestamp: number;
  } | null;
}

interface PoolsResponse {
  count: number;
  pools: PoolEntry[];
}

type State =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; pools: PoolEntry[] }
  | { status: 'error'; error: string };

export function useMarketPools(): State {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/v1/pools', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PoolsResponse;
        if (!cancelled) setState({ status: 'ready', pools: data.pools });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', error: (err as Error).message });
      }
    };
    void load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return state;
}

/** EGAZ trading pair shows the non-ETX leg as "EGAZ", matching the rest of the UI. */
function displaySymbol(sym: string | null): string {
  if (!sym) return '?';
  if (sym === 'WEGAZ') return 'EGAZ';
  return sym;
}

export function MarketVolumeStrip(props: { className?: string }) {
  const state = useMarketPools();

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className={`rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/40 ${props.className ?? ''}`}>
        Loading 24h market volume…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={`rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-red-300/80 ${props.className ?? ''}`}>
        Couldn&apos;t load 24h volume: {state.error}
      </div>
    );
  }
  if (state.status !== 'ready') return null;

  const withVolume = state.pools.filter((p: PoolEntry) => p.volume_24h !== null);
  if (withVolume.length === 0) {
    return (
      <div className={`rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/40 ${props.className ?? ''}`}>
        No pool volume reported in the last 24h.
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border border-white/10 bg-white/5 p-4 ${props.className ?? ''}`}>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-white/80">24h market volume</h3>
        <span className="text-xs text-white/40">per-token gross turnover</span>
      </div>
      <div className="divide-y divide-white/5">
        {withVolume.map((p) => {
          const vol = p.volume_24h!;
          const baseDec = p.base.decimals ?? 18;
          const quoteDec = p.quote.decimals ?? 18;
          const baseAmt = formatShortAmount(BigInt(vol.base), baseDec);
          const quoteAmt = formatShortAmount(BigInt(vol.quote), quoteDec);
          const bSym = displaySymbol(p.base.symbol);
          const qSym = displaySymbol(p.quote.symbol);
          return (
            <div
              key={p.pool_address}
              className="flex items-center justify-between py-2 text-sm"
            >
              <span className="text-white/70">
                {bSym} / {qSym}
              </span>
              <span className="text-right text-white/80">
                <span className="inline-block">
                  {baseAmt} {bSym}
                </span>
                <span className="px-1 text-white/30">·</span>
                <span className="inline-block">
                  {quoteAmt} {qSym}
                </span>
                <span className="ml-2 text-xs text-white/40">
                  {vol.swap_count} swap{vol.swap_count === 1 ? '' : 's'}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
