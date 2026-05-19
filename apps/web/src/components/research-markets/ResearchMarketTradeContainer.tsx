/**
 * Client wrapper that fetches a single research market by token address +
 * the singleton's graduation threshold, then hands off to
 * `<ResearchMarketTradeView />`. Handles three states:
 *
 *   1. loading            — singleton not yet reachable / read pending
 *   2. not graduated      — token exists but hasn't crossed 100k ETX yet;
 *                           we tell the user and link them to the launchpad
 *                           detail page (which has the same buy/sell card)
 *   3. unknown token      — singleton returned nothing for this address;
 *                           treat as 404-ish and link back to /trade
 *
 * Trading is gated on graduation because that is the explicit listing
 * criterion the launchpad UI promised — non-graduated tokens stay only
 * inside `/research-markets`.
 */
'use client';

import Link from 'next/link';
import type { Address } from 'viem';
import { ResearchMarketTradeView } from './ResearchMarketTradeView';
import {
  useResearchMarket,
  useResearchMarketsConfig,
} from '@/lib/research-markets';

type Props = {
  token: Address;
};

export function ResearchMarketTradeContainer({ token }: Props) {
  const market = useResearchMarket(token);
  const config = useResearchMarketsConfig();

  if (config === null || market === null) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#07120f] p-6 text-sm text-white/55">
        Loading market…
      </div>
    );
  }

  if (market.token === '0x0000000000000000000000000000000000000000') {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#07120f] p-6">
        <div className="text-sm font-semibold text-white">Market not found</div>
        <p className="mt-2 text-xs text-white/55">
          No research market is registered at this address on the connected
          chain.
        </p>
        <Link
          href="/research-markets"
          className="mt-3 inline-block text-xs text-emerald-300 hover:text-emerald-200"
        >
          See all research markets →
        </Link>
      </div>
    );
  }

  const isGraduated =
    market.status === 'graduated' ||
    market.virtualEtxAcc >= config.graduationThreshold;

  if (!isGraduated) {
    return (
      <div className="rounded-2xl border border-amber-400/20 bg-[#100d05] p-6">
        <div className="text-sm font-semibold text-amber-200">
          {market.symbol} hasn’t graduated yet
        </div>
        <p className="mt-2 text-xs text-white/65">
          Research-market tokens are only listed on the trading terminal
          after they cross the 100k ETX bonding-curve threshold. Until
          then, you can still buy and sell on the launchpad detail page —
          same singleton, same curve, just gated UI surface.
        </p>
        <Link
          href={`/research-markets/${market.token}`}
          className="mt-3 inline-block rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-300"
        >
          Trade on launchpad →
        </Link>
      </div>
    );
  }

  return (
    <ResearchMarketTradeView
      market={market}
      graduationThreshold={config.graduationThreshold}
    />
  );
}
