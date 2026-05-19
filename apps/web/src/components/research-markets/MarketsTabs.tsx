/**
 * Top-level launchpad client component. Fetches all markets via
 * `useResearchMarkets()` and renders four tabs:
 *   - Live              — recently launched, < 80% of graduation threshold
 *   - Pending graduation — ≥ 80% of threshold, not yet graduated
 *   - Graduated         — crossed threshold, now listed in /swap + /trade
 *   - Sunset            — 30d no-trade, ETX reserve recycled to pool
 *
 * Each tab renders a grid of `<MarketCard />` instances. Empty state with
 * helpful guidance per bucket.
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MarketCard } from './MarketCard';
import {
  useResearchMarkets,
  useResearchMarketsAddress,
  type MarketStatus,
} from '@/lib/research-markets';

const TABS: { id: MarketStatus; label: string; hint: string }[] = [
  { id: 'live', label: 'Live', hint: 'Active research markets accepting buys.' },
  {
    id: 'pending',
    label: 'Pending graduation',
    hint: 'Tokens close to the 100k ETX graduation threshold.',
  },
  {
    id: 'graduated',
    label: 'Graduated',
    hint: 'Tokens crossed the threshold and are listed on /swap + /trade.',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    hint: '30 days without trades. Reserve recycled to the shared pool.',
  },
];

export function MarketsTabs() {
  const [active, setActive] = useState<MarketStatus>('live');
  const singleton = useResearchMarketsAddress();
  const { byStatus, graduationThreshold, sunsetWindow, isLoading } = useResearchMarkets();

  if (!singleton) {
    return (
      <div className="rounded-xl border border-amber-700/40 bg-amber-500/10 p-6 text-amber-200">
        <h3 className="text-base font-semibold">EticaResearchMarkets is not deployed on this chain.</h3>
        <p className="mt-2 text-sm">
          Connect to Etica mainnet (chain id 61803) to browse research markets. The treasury can
          deploy the singleton via{' '}
          <Link href="/deploy/research-markets" className="underline">
            /deploy/research-markets
          </Link>
          .
        </p>
      </div>
    );
  }

  const list = byStatus[active];
  const tab = TABS.find((t) => t.id === active)!;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => {
            const count = byStatus[t.id].length;
            const isActive = t.id === active;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive(t.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  isActive
                    ? 'border-sky-600 bg-sky-600/20 text-sky-200'
                    : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                }`}
              >
                {t.label}
                <span className="ml-1.5 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-300">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <Link
          href="/research-markets/launch"
          className="rounded-lg border border-emerald-700 bg-emerald-600/20 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-600/30"
        >
          + Launch token
        </Link>
      </div>

      <p className="text-xs text-zinc-500">{tab.hint}</p>

      {isLoading && list.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-12 text-center text-sm text-zinc-500">
          Loading markets…
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-12 text-center">
          <p className="text-sm text-zinc-400">No tokens in this bucket yet.</p>
          {active === 'live' && (
            <Link
              href="/research-markets/launch"
              className="mt-3 inline-block text-xs font-semibold text-sky-400 underline"
            >
              Be the first to launch
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((m) => (
            <MarketCard
              key={m.token}
              market={m}
              graduationThreshold={graduationThreshold}
              sunsetWindow={sunsetWindow}
            />
          ))}
        </div>
      )}
    </div>
  );
}
