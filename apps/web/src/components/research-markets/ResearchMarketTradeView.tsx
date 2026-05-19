/**
 * Trade-tab variant of the research-markets buy/sell surface. Used when
 * a user lands on `/trade/[address]` where [address] is a graduated
 * research-token. The view reuses the launchpad `<BuySellCard />` for
 * actual settlement (settles directly against the singleton bonding
 * curve), and layers in the market header + key stats so the surface
 * matches the rest of the trading terminal.
 *
 * Why a separate view: graduated research tokens trade against the
 * shared 5M-ETX pool inside the singleton — they do NOT have an external
 * LP, so the Dutch-order reactor + keeper stack used by the standard
 * /trade pairs cannot fill them. Routing them into the standard
 * TradeView would expose order types (Limit/Stop/DCA/Grid) that cannot
 * settle. The bonding curve is the venue; this view makes that explicit.
 */
'use client';

import Link from 'next/link';
import { formatUnits } from 'viem';
import { BuySellCard } from './BuySellCard';
import {
  graduationProgress,
  resolveImageURI,
  type ResearchMarket,
} from '@/lib/research-markets';

function formatEtx(value: bigint): string {
  const n = Number(formatUnits(value, 18));
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

type Props = {
  market: ResearchMarket;
  graduationThreshold: bigint;
};

export function ResearchMarketTradeView({ market, graduationThreshold }: Props) {
  const imageSrc = resolveImageURI(market.imageURI);
  const progressPct = graduationProgress(market, graduationThreshold);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-400/15 bg-[#06110e] p-5">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950">
            {imageSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageSrc}
                alt={`${market.symbol} logo`}
                className="h-full w-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <span className="text-xs font-semibold text-zinc-500">
                {market.symbol.slice(0, 3)}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-white">
                {market.name}
              </h2>
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                {market.symbol}
              </span>
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                Graduated
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-white/60">
              {market.description || 'No description provided.'}
            </p>
            <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-zinc-500">
              <span title={market.token}>
                Contract: <span className="text-zinc-300">{shortAddress(market.token)}</span>
              </span>
              <Link
                href={`/research-markets/${market.token}`}
                className="text-emerald-300 hover:text-emerald-200"
              >
                Full launchpad view →
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <Stat
            label="ETX in pool"
            value={`${formatEtx(market.virtualEtxAcc)} ETX`}
          />
          <Stat
            label="Token supply"
            value={`${formatEtx(market.tokenSupply)} ${market.symbol}`}
          />
          <Stat
            label="Graduation"
            value={`${progressPct.toFixed(0)}%`}
            sub={`${formatEtx(graduationThreshold)} ETX target`}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-emerald-400/15 bg-[#06110e] p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
            Bonding-curve venue
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
            ETX ↔ {market.symbol}
          </span>
        </div>
        <BuySellCard market={market} />
        <p className="mt-3 text-[11px] leading-5 text-white/45">
          This market settles against the EticaResearchMarkets singleton —
          there is no external LP, no Dutch order, no grid bot. Buy/sell at
          the bonding-curve quote with 1% slippage default. Advanced order
          surfaces (Limit / Stop / DCA / Grid) are not available for
          bonding-curve markets and are intentionally hidden here.
        </p>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/40">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm text-zinc-100">{value}</div>
      {sub ? (
        <div className="mt-0.5 text-[10px] text-white/40">{sub}</div>
      ) : null}
    </div>
  );
}
