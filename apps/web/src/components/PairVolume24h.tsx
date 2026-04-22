'use client';

/**
 * Fetch + render the last-24h gross turnover for an EticaSwap V2 pair.
 *
 * Reads from `/api/v1/pairs/{address}/volume?window=24h`, which does the
 * `eth_getLogs` tail-scan server-side and caches the result at the route
 * layer. Clients poll on the same cadence as the API cache window so we
 * don't stampede the RPC when many users load `/swap` at once.
 *
 * Rendering policy: the component is display-only; consumers wrap it in
 * whatever row / card they need. It formats as a single short string like
 * "12.34k ETX / 1,234 ETI (42 swaps)" so a single text slot is enough.
 */

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { formatUnits } from 'viem';

export interface PairVolume24hResponse {
  pair: Address;
  window: '24h';
  windowSeconds: number;
  fromBlock: string;
  toBlock: string;
  fromTimestamp: number;
  toTimestamp: number;
  token0: {
    address: Address;
    symbol: string | null;
    decimals: number | null;
    volume: string;
  };
  token1: {
    address: Address;
    symbol: string | null;
    decimals: number | null;
    volume: string;
  };
  swapCount: number;
}

interface State {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: PairVolume24hResponse;
  error?: string;
}

/** Polls the pair-volume endpoint on the same cadence as its cache window. */
export function usePairVolume24h(pair: Address | null | undefined): State {
  const [state, setState] = useState<State>({ status: 'idle' });

  useEffect(() => {
    if (!pair) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    // Reset state when the pair changes so we never render stale data from a
    // previous pair while the next fetch is in flight.
    setState({ status: 'loading' });
    const load = async () => {
      try {
        const res = await fetch(`/api/v1/pairs/${pair}/volume?window=24h`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PairVolume24hResponse;
        if (!cancelled) setState({ status: 'ready', data });
      } catch (err) {
        if (!cancelled) {
          setState({ status: 'error', error: (err as Error).message });
        }
      }
    };
    void load();
    // Match the server-side cache window so clients don't over-poll.
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pair]);

  return state;
}

/** Abbreviates a large token amount as e.g. "12.34k" / "1.20M" / "42.00". */
export function formatShortAmount(raw: bigint, decimals: number): string {
  const human = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(human) || human === 0) return '0';
  const abs = Math.abs(human);
  if (abs >= 1_000_000_000) return `${(human / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(human / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(human / 1_000).toFixed(2)}k`;
  if (abs >= 1) return human.toFixed(2);
  return human.toPrecision(3);
}

export function PairVolume24h(props: {
  pair: Address | null | undefined;
  className?: string;
}) {
  const { status, data } = usePairVolume24h(props.pair);

  if (!props.pair) {
    return <span className={props.className}>—</span>;
  }
  if (status !== 'ready' || !data) {
    return <span className={props.className}>…</span>;
  }

  const t0 = data.token0;
  const t1 = data.token1;
  const s0 = t0.symbol ?? 'token0';
  const s1 = t1.symbol ?? 'token1';
  const v0 = formatShortAmount(BigInt(t0.volume), t0.decimals ?? 18);
  const v1 = formatShortAmount(BigInt(t1.volume), t1.decimals ?? 18);
  return (
    <span className={props.className} title={`${data.swapCount} swap${data.swapCount === 1 ? '' : 's'} in last 24h`}>
      {v0} {s0} · {v1} {s1}
    </span>
  );
}
