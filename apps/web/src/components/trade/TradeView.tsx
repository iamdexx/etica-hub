'use client';

import Link from 'next/link';
import { MarketVolumeStrip } from '../MarketVolumeStrip';
import { OnChainPriceChart } from './OnChainPriceChart';
import { PriceChart } from './PriceChart';
import { TradeTabs } from './TradeTabs';

export interface TradeViewProps {
  baseSymbol: 'ETI' | 'EGAZ';
  pairId: 'ETI-ETX' | 'EGAZ-ETX';
  apiBaseUrl: string;
}

const DESCRIPTIONS: Record<TradeViewProps['baseSymbol'], string> = {
  ETI: 'Buy and sell ETI against ETX. Price feed is sourced from the on-chain ETI/ETX pool reserves.',
  EGAZ: 'Buy and sell EGAZ against ETX. Price feed is sourced from the on-chain EGAZ/ETX pool reserves.',
};

export function TradeView({ baseSymbol, pairId, apiBaseUrl }: TradeViewProps) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <header className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Trade {baseSymbol}</h1>
            <div className="flex gap-1">
              {(['ETI', 'EGAZ'] as const).map((s) => (
                <Link
                  key={s}
                  href={`/trade/${s}`}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    s === baseSymbol
                      ? 'border-brand-accent bg-brand-accent text-brand-ink'
                      : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {s}/ETX
                </Link>
              ))}
            </div>
            <Link
              href="/trade/orders"
              className="ml-auto rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              My orders →
            </Link>
          </div>
          <p className="text-sm text-white/60">{DESCRIPTIONS[baseSymbol]}</p>
        </header>
        {apiBaseUrl ? (
          <PriceChart
            pairId={pairId}
            baseSymbol={baseSymbol}
            quoteSymbol="ETX"
            apiBaseUrl={apiBaseUrl}
          />
        ) : (
          <OnChainPriceChart key={baseSymbol} baseSymbol={baseSymbol} quoteSymbol="ETX" />
        )}
        <MarketVolumeStrip />
      </div>
      <aside className="space-y-3">
        <TradeTabs baseSymbol={baseSymbol} />
        <p className="text-[11px] leading-relaxed text-white/40">
          EticaHub never holds your funds or keys. Market orders execute immediately through the
          EticaSwap V2 router; your wallet signs every transaction.
        </p>
      </aside>
    </div>
  );
}
