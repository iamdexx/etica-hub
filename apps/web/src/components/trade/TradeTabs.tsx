'use client';

import { useState } from 'react';
import { SwapCard } from '../swap/SwapCard';
import { LimitForm } from './LimitForm';
import { StopForm } from './StopForm';
import { DcaForm } from './DcaForm';

type Tab = 'market' | 'limit' | 'stop' | 'dca';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'market', label: 'Market' },
  { key: 'limit', label: 'Limit' },
  { key: 'stop', label: 'Stop' },
  { key: 'dca', label: 'DCA' },
];

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
      {tab === 'stop' && <StopForm baseSymbol={baseSymbol} />}
      {tab === 'dca' && <DcaForm baseSymbol={baseSymbol} />}
    </div>
  );
}
