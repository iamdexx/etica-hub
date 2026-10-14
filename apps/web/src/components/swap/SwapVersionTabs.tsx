'use client';

/**
 * Version tabs for /swap. One venue per EticaSwap generation:
 *   V2 hub swap · V3 stableswap · V4 research launchpad · V5 Direct windows.
 * The active tab is mirrored into `?v=` so links can deep-link a venue.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SwapCard } from './SwapCard';
import { DirectSwapCard } from './DirectSwapCard';
import { LaunchpadLiteCard } from './LaunchpadLiteCard';

export type SwapVersion = 'v2' | 'v3' | 'v4' | 'v5';

const TABS: { id: SwapVersion; label: string; title: string; hint: string }[] = [
  {
    id: 'v2',
    label: 'V2',
    title: 'Hub swap',
    hint: 'EGAZ, ETI, ETX and USDC.e. Every route passes through ETX, 0.30% LP fee.',
  },
  {
    id: 'v3',
    label: 'V3',
    title: 'Stableswap',
    hint: 'stETX to ETX on the rate-aware pool, 0.04% fee.',
  },
  {
    id: 'v4',
    label: 'V4',
    title: 'Launchpad',
    hint: 'Research tokens on the bonding curve. Graduates onto the hub.',
  },
  {
    id: 'v5',
    label: 'V5',
    title: 'Direct',
    hint: 'Dollar markets with no pool of their own. Every trade settles on the ETX hub. stETX holders only.',
  },
];

const isVersion = (v: string | null): v is SwapVersion =>
  v === 'v2' || v === 'v3' || v === 'v4' || v === 'v5';

export function SwapVersionTabs({ geoRestricted = false }: { geoRestricted?: boolean }) {
  const [active, setActive] = useState<SwapVersion>('v2');

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('v');
    if (isVersion(v)) setActive(v);
  }, []);

  function select(v: SwapVersion) {
    setActive(v);
    const url = new URL(window.location.href);
    if (v === 'v2') url.searchParams.delete('v');
    else url.searchParams.set('v', v);
    window.history.replaceState(null, '', url);
  }

  const tab = TABS.find((t) => t.id === active)!;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-1 rounded-xl border border-white/[0.07] bg-black/30 p-1">
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => select(t.id)}
              aria-pressed={isActive}
              className={`rounded-lg px-2 py-2 text-center transition ${
                isActive
                  ? 'bg-emerald-500/15 text-emerald-200 shadow-inner'
                  : 'text-white/55 hover:bg-white/[0.04] hover:text-white/85'
              }`}
            >
              <div className="text-sm font-semibold">{t.label}</div>
              <div className="text-[10px] leading-3 opacity-80">{t.title}</div>
            </button>
          );
        })}
      </div>
      <p className="px-1 text-xs leading-5 text-white/50">{tab.hint}</p>

      {active === 'v2' && <SwapCard geoRestricted={geoRestricted} />}

      {active === 'v3' &&
        (geoRestricted ? (
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5 text-sm text-white/55">
            stETX is not offered in your region, so the stableswap venue is hidden. The V2 hub
            and V5 Direct markets stay open.
          </div>
        ) : (
          <div className="space-y-3">
            <SwapCard defaultFrom="stETX" defaultTo="ETX" />
            <p className="px-1 text-[11px] text-white/40">
              Need stETX? <Link href="/stake" className="text-emerald-300 hover:text-emerald-200">Stake ETX</Link>
              {' · '}
              <Link href="/pool" className="text-emerald-300 hover:text-emerald-200">Add stableswap liquidity</Link>
            </p>
          </div>
        ))}

      {active === 'v4' && <LaunchpadLiteCard />}

      {active === 'v5' && <DirectSwapCard />}
    </div>
  );
}
