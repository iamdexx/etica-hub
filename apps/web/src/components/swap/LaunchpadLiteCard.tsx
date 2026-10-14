'use client';

/**
 * V4 tab on /swap: a lite view of the research launchpad. Picks a live
 * bonding-curve market and renders the launchpad's own BuySellCard for it;
 * the full launchpad (charts, evidence, graduation progress) stays at
 * /research-markets.
 */

import Link from 'next/link';
import { useState } from 'react';
import type { Address } from 'viem';
import { BuySellCard } from '@/components/research-markets/BuySellCard';
import { useResearchMarkets, graduationProgress } from '@/lib/research-markets';

export function LaunchpadLiteCard() {
  const { byStatus, graduationThreshold, isLoading } = useResearchMarkets();
  // `pending` is the UI bucket for markets past 80% of graduation; they still trade on the curve.
  const live = [...(byStatus?.pending ?? []), ...(byStatus?.live ?? [])];
  const [sel, setSel] = useState<Address | null>(null);
  const market = live.find((m) => m.token === sel) ?? live[0] ?? null;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-white/70">Launchpad</h2>
          <span className="text-xs text-white/40">v4 · bonding curve · graduates to the hub</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-white/55">
          Research tokens launch on a single curve priced in ETX. Buy early, sell back to the
          curve any time; at the graduation threshold the market moves onto the ETX hub.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/research-markets" className="btn-tone px-3 py-1.5 text-xs">
            Full launchpad
          </Link>
          <Link href="/research-markets/launch" className="btn-ghost px-3 py-1.5 text-xs">
            Launch a token
          </Link>
        </div>

        {live.length > 1 && (
          <div className="mt-4">
            <label className="text-[11px] uppercase tracking-eyebrow text-white/45">Market</label>
            <select
              value={market?.token ?? ''}
              onChange={(e) => setSel(e.target.value as Address)}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-white outline-none"
            >
              {live.map((m) => (
                <option key={m.token} value={m.token}>
                  {m.symbol} · {m.name} · {Math.round(graduationProgress(m, graduationThreshold) * 100)}% to graduation
                </option>
              ))}
            </select>
          </div>
        )}
        {market && live.length === 1 && (
          <div className="mt-4 text-xs text-white/55">
            {market.symbol} · {market.name} ·{' '}
            {Math.round(graduationProgress(market, graduationThreshold) * 100)}% to graduation
          </div>
        )}
      </div>

      {market ? (
        <BuySellCard market={market} />
      ) : (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5 text-sm text-white/55">
          {isLoading ? 'Loading markets…' : 'No live markets right now. Launch the first one.'}
        </div>
      )}
    </div>
  );
}
