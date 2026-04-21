'use client';

import { useState } from 'react';
import { SwapCard } from '../swap/SwapCard';
import { LimitForm } from './LimitForm';

type Tab = 'market' | 'limit' | 'stop';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'market', label: 'Market' },
  { key: 'limit', label: 'Limit' },
  { key: 'stop', label: 'Stop' },
];

function ComingSoonPanel({ strategy }: { strategy: 'stop' }) {
  const copy =
    'Protect a position with a stop-loss trigger. Your order rests until price crosses the trigger, at which point a keeper executes the swap. Non-custodial; cancellable any time.';
  return (
    <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5 text-sm">
      <div className="mb-1 text-xs uppercase tracking-wider text-amber-200/80">
        Coming in next release
      </div>
      <p className="text-white/80">{copy}</p>
      <p className="mt-3 text-xs text-white/50">
        Ships alongside DCA, bounded grid, and infinite-grid wizards. Same signing primitive as Limit;
        the keeper just holds the fill until the trigger fires.
      </p>
    </div>
  );
}

export interface TradeTabsProps {
  baseSymbol: 'ETI' | 'EGAZ';
}

export function TradeTabs({ baseSymbol }: TradeTabsProps) {
  const [tab, setTab] = useState<Tab>('market');
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-full px-3 py-1.5 text-sm transition-colors ${
              tab === t.key
                ? 'bg-brand-accent text-brand-ink'
                : 'text-white/70 hover:bg-white/5 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'market' && <SwapCard />}
      {tab === 'limit' && <LimitForm baseSymbol={baseSymbol} />}
      {tab === 'stop' && <ComingSoonPanel strategy="stop" />}
    </div>
  );
}
