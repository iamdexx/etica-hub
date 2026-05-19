/**
 * GraduatedMarketsSection — compact, embeddable list of graduated
 * research-token markets for use on `/swap` and `/trade`. Renders nothing
 * (zero DOM) when no graduated markets exist on the connected chain so
 * the host page doesn't show an empty card.
 *
 * Each entry links into:
 *   - `/research-markets/[token]`  → full bonding-curve buy/sell + detail
 *   - `/trade/[token]`             → trade-style chart + bonding-curve panel
 *
 * Trading itself never happens here — this is a discovery surface. The
 * detail and trade pages own the actual buy/sell flows.
 */
'use client';

import Link from 'next/link';
import { formatUnits } from 'viem';
import {
  useResearchMarkets,
  resolveImageURI,
  type ResearchMarket,
} from '@/lib/research-markets';

type Props = {
  /** Where the "Trade" CTA should point: 'swap' shows the launchpad detail
   *  link; 'trade' shows the /trade/[address] link. Both render the buy/sell
   *  bonding-curve UI on the destination. */
  ctaTarget?: 'swap' | 'trade';
  /** Cap the number of cards shown inline. The footer link always points
   *  to `/research-markets` for the full list. Defaults to 6. */
  maxItems?: number;
};

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

function GraduatedRow({
  market,
  ctaHref,
}: {
  market: ResearchMarket;
  ctaHref: string;
}) {
  const imageSrc = resolveImageURI(market.imageURI);
  return (
    <Link
      href={ctaHref}
      className="group flex items-center gap-3 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04] p-3 transition hover:border-emerald-400/40 hover:bg-emerald-500/[0.08]"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
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
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-zinc-50">
            {market.name}
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            {market.symbol}
          </span>
          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
            Graduated
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
          {shortAddress(market.token)}
        </div>
      </div>
      <div className="hidden text-right sm:block">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          ETX in pool
        </div>
        <div className="font-mono text-xs text-zinc-200">
          {formatEtx(market.virtualEtxAcc)}
        </div>
      </div>
      <div className="text-xs font-medium text-emerald-300 transition group-hover:text-emerald-200">
        Trade →
      </div>
    </Link>
  );
}

export function GraduatedMarketsSection({
  ctaTarget = 'swap',
  maxItems = 6,
}: Props) {
  const { byStatus, isLoading } = useResearchMarkets();
  const graduated = byStatus?.graduated ?? [];

  if (isLoading || graduated.length === 0) {
    return null;
  }

  const visible = graduated.slice(0, maxItems);

  return (
    <section className="rounded-2xl border border-emerald-400/15 bg-[#06110e] p-5 shadow-xl shadow-emerald-950/10">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[10px] uppercase tracking-wider text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
            Graduated Research Markets
          </div>
          <h2 className="mt-2 text-base font-semibold text-zinc-50">
            Trade tokens that crossed 100k ETX
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Bonding-curve venues backed by the shared 5M ETX pool. Trades
            settle directly against the EticaResearchMarkets singleton — no
            external LP, same router for every fill.
          </p>
        </div>
        <Link
          href="/research-markets"
          className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
        >
          View all markets →
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
        {visible.map((market) => {
          const ctaHref =
            ctaTarget === 'trade'
              ? `/trade/${market.token}`
              : `/research-markets/${market.token}`;
          return (
            <GraduatedRow
              key={market.token}
              market={market}
              ctaHref={ctaHref}
            />
          );
        })}
      </div>

      {graduated.length > maxItems ? (
        <div className="mt-3 text-center text-[11px] text-zinc-600">
          +{graduated.length - maxItems} more graduated tokens — see{' '}
          <Link
            href="/research-markets"
            className="text-emerald-300 hover:text-emerald-200"
          >
            full launchpad
          </Link>
          .
        </div>
      ) : null}
    </section>
  );
}
