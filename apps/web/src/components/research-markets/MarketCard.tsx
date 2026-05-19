/**
 * Per-market card rendered inside each launchpad tab. Shows the on-chain
 * image, name+symbol, description, key reserve stats, graduation progress
 * bar, and links into the per-token detail page at
 * `/research-markets/[address]`.
 *
 * Pure presentational — all data is fetched once by `<MarketsTabs />` via
 * `useResearchMarkets()` and passed down. Optimised for dense grid layout
 * on `/research-markets`.
 */
'use client';

import Link from 'next/link';
import { formatUnits } from 'viem';
import {
  graduationProgress,
  resolveImageURI,
  type ResearchMarket,
} from '@/lib/research-markets';

type Props = {
  market: ResearchMarket;
  graduationThreshold: bigint;
  sunsetWindow: bigint;
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

function ageText(timestamp: bigint): string {
  if (timestamp === 0n) return '—';
  const now = Math.floor(Date.now() / 1000);
  const seconds = now - Number(timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function MarketCard({ market, graduationThreshold, sunsetWindow }: Props) {
  const imageSrc = resolveImageURI(market.imageURI);
  const progress = graduationProgress(market, graduationThreshold);
  const isGraduated = market.status === 'graduated';
  const isSunset = market.status === 'sunset';
  const isPending = market.status === 'pending';

  const statusPill = isGraduated
    ? { label: 'Graduated', bg: 'bg-emerald-500/20', text: 'text-emerald-300' }
    : isSunset
      ? { label: 'Sunset', bg: 'bg-zinc-500/20', text: 'text-zinc-400' }
      : isPending
        ? { label: 'Pending', bg: 'bg-amber-500/20', text: 'text-amber-300' }
        : { label: 'Live', bg: 'bg-sky-500/20', text: 'text-sky-300' };

  const sunsetSecs = Number(sunsetWindow);
  const inactiveSecs = market.lastTradeAt === 0n
    ? Number(BigInt(Math.floor(Date.now() / 1000)) - market.launchedAt)
    : Number(BigInt(Math.floor(Date.now() / 1000)) - market.lastTradeAt);
  const sunsetEta = !isSunset && !isGraduated && sunsetSecs > 0
    ? Math.max(0, sunsetSecs - inactiveSecs)
    : null;

  return (
    <Link
      href={`/research-markets/${market.token}`}
      className="group relative flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition hover:border-sky-700 hover:bg-zinc-900"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
          {imageSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageSrc}
              alt={market.name}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="text-xs text-zinc-600">no image</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">
              {market.name || 'Unnamed'}
              <span className="ml-2 text-xs font-normal text-zinc-500">
                ${market.symbol || '?'}
              </span>
            </h3>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusPill.bg} ${statusPill.text}`}
            >
              {statusPill.label}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-zinc-400">
            {market.description || 'No description provided.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
          <div className="text-zinc-500">Reserve</div>
          <div className="font-medium text-zinc-100">{formatEtx(market.virtualEtxAcc)} ETX</div>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
          <div className="text-zinc-500">Supply</div>
          <div className="font-medium text-zinc-100">{formatEtx(market.tokenSupply)}</div>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
          <div className="text-zinc-500">Last trade</div>
          <div className="font-medium text-zinc-100">{ageText(market.lastTradeAt)}</div>
        </div>
      </div>

      {!isSunset && !isGraduated && graduationThreshold > 0n && (
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-500">
            <span>Graduation</span>
            <span>{progress.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full ${isPending ? 'bg-amber-500' : 'bg-sky-500'}`}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        </div>
      )}

      {isGraduated && (
        <div className="rounded border border-emerald-700/40 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">
          Listed on /swap and /trade
        </div>
      )}

      {sunsetEta !== null && sunsetEta < 7 * 86400 && (
        <div className="rounded border border-amber-700/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
          Sunsets in {Math.floor(sunsetEta / 86400)}d {Math.floor((sunsetEta % 86400) / 3600)}h if no trade
        </div>
      )}

      <div className="mt-auto flex items-center justify-between text-[10px] text-zinc-500">
        <span>by {shortAddress(market.researcher)}</span>
        <span>{ageText(market.launchedAt)}</span>
      </div>
    </Link>
  );
}
