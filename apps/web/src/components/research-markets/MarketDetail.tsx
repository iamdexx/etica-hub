/**
 * Per-token detail view. Reads the market via `useResearchMarket(token)`,
 * renders metadata (image, description, socials, evidence link), bonding
 * curve stats, and a `<BuySellCard />` for interactive trading.
 */
'use client';

import Link from 'next/link';
import { formatUnits, type Address } from 'viem';
import {
  useResearchMarket,
  useResearchMarkets,
  resolveImageURI,
  graduationProgress,
} from '@/lib/research-markets';
import { BuySellCard } from './BuySellCard';

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatEtx(value: bigint): string {
  const n = Number(formatUnits(value, 18));
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(3)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(3)}K`;
  return n.toFixed(4);
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

function externalLink(url: string): string | null {
  const t = url.trim();
  if (!t) return null;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  if (t.startsWith('@')) return `https://x.com/${t.slice(1)}`;
  return null;
}

function evidenceLink(uri: string): string | null {
  const t = uri.trim();
  if (!t) return null;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  if (t.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${t.slice(7)}`;
  if (/^10\.\d{4,9}\//.test(t)) return `https://doi.org/${t}`;
  if (/^arXiv:/i.test(t)) return `https://arxiv.org/abs/${t.slice(6)}`;
  if (/^PDB:/i.test(t)) return `https://www.rcsb.org/structure/${t.slice(4)}`;
  if (/^ORCID:/i.test(t)) return `https://orcid.org/${t.slice(6)}`;
  if (/^EticaLabs:/i.test(t)) return `/labs/feed/${t.slice(10)}`;
  return null;
}

export function MarketDetail({ token }: { token: Address }) {
  const market = useResearchMarket(token);
  const { graduationThreshold, sunsetWindow } = useResearchMarkets();

  if (!market) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <Link href="/research-markets" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Back to markets
        </Link>
        <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-400">
          Loading market <span className="font-mono text-xs text-zinc-500">{shortAddress(token)}</span>…
          <p className="mt-2 text-[11px] text-zinc-600">
            If this market does not exist on the connected chain, you may be on the wrong network.
          </p>
        </div>
      </main>
    );
  }

  const progress = graduationProgress(market, graduationThreshold);
  const imageSrc = resolveImageURI(market.imageURI);
  const isGraduated = market.status === 'graduated';
  const isSunset = market.status === 'sunset';

  const statusPill = isGraduated
    ? { label: 'Graduated', bg: 'bg-emerald-500/20', text: 'text-emerald-300' }
    : isSunset
      ? { label: 'Sunset', bg: 'bg-zinc-500/20', text: 'text-zinc-400' }
      : market.status === 'pending'
        ? { label: 'Pending graduation', bg: 'bg-amber-500/20', text: 'text-amber-300' }
        : { label: 'Live', bg: 'bg-sky-500/20', text: 'text-sky-300' };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <Link href="/research-markets" className="text-xs text-zinc-500 hover:text-zinc-300">
        ← Back to markets
      </Link>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column — metadata + stats */}
        <div className="space-y-6 lg:col-span-2">
          <div className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 sm:flex-row">
            <div className="flex h-32 w-32 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950">
              {imageSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageSrc} alt={market.name} className="h-full w-full object-cover" />
              ) : (
                <span className="text-xs text-zinc-600">no image</span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold text-zinc-50">{market.name || 'Unnamed'}</h1>
                <span className="text-base text-zinc-500">${market.symbol || '?'}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${statusPill.bg} ${statusPill.text}`}
                >
                  {statusPill.label}
                </span>
              </div>
              <p className="text-sm text-zinc-300">{market.description || 'No description provided.'}</p>
              <div className="flex flex-wrap gap-3 text-xs">
                {market.website && externalLink(market.website) && (
                  <a href={externalLink(market.website)!} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300">
                    Website ↗
                  </a>
                )}
                {market.telegram && externalLink(market.telegram) && (
                  <a href={externalLink(market.telegram)!} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300">
                    Telegram ↗
                  </a>
                )}
                {market.xUrl && externalLink(market.xUrl) && (
                  <a href={externalLink(market.xUrl)!} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300">
                    X / Twitter ↗
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Evidence */}
          {market.evidenceURI && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="text-sm font-semibold text-zinc-100">Scientific evidence</h3>
              <p className="mt-1 text-xs text-zinc-500">
                Referenced at launch — stored immutably on the deployed ResearchToken contract.
              </p>
              <div className="mt-2 break-all font-mono text-xs text-zinc-300">{market.evidenceURI}</div>
              {evidenceLink(market.evidenceURI) && (
                <a
                  href={evidenceLink(market.evidenceURI)!}
                  target={evidenceLink(market.evidenceURI)!.startsWith('http') ? '_blank' : undefined}
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-sky-400 hover:text-sky-300"
                >
                  Open reference ↗
                </a>
              )}
            </div>
          )}

          {/* Bonding curve stats */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="ETX reserve" value={`${formatEtx(market.virtualEtxAcc)} ETX`} />
            <Stat label="Token supply" value={formatEtx(market.tokenSupply)} />
            <Stat label="Launched" value={ageText(market.launchedAt)} />
            <Stat label="Last trade" value={ageText(market.lastTradeAt)} />
          </div>

          {/* Graduation progress */}
          {!isGraduated && !isSunset && graduationThreshold > 0n && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Graduation progress</span>
                <span>
                  {formatEtx(market.virtualEtxAcc)} / {formatEtx(graduationThreshold)} ETX ({progress.toFixed(1)}%)
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full ${market.status === 'pending' ? 'bg-amber-500' : 'bg-sky-500'}`}
                  style={{ width: `${Math.min(100, progress)}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-zinc-500">
                Once reserve crosses {formatEtx(graduationThreshold)} ETX, this token is listed on{' '}
                <code className="rounded bg-zinc-800 px-1">/swap</code> and{' '}
                <code className="rounded bg-zinc-800 px-1">/trade</code>. Bonding curve remains the
                only venue — no migration, no LP positions.
              </p>
            </div>
          )}

          {isGraduated && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-700/40 bg-emerald-500/10 p-5 text-sm text-emerald-200">
              <div>
                <p className="font-semibold">Graduated</p>
                <p className="mt-1 text-xs text-emerald-300/80">
                  This token is listed on swap + trade. All routes settle through the same
                  bonding curve.
                </p>
              </div>
              <div className="flex gap-2">
                <Link
                  href={`/swap?to=${market.token}`}
                  className="rounded-lg border border-emerald-600 bg-emerald-600/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-600/30"
                >
                  Open in /swap
                </Link>
                <Link
                  href={`/trade?pair=${market.token}`}
                  className="rounded-lg border border-emerald-600 bg-emerald-600/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-600/30"
                >
                  Open in /trade
                </Link>
              </div>
            </div>
          )}

          {isSunset && (
            <div className="rounded-xl border border-zinc-700 bg-zinc-900/40 p-5 text-sm text-zinc-300">
              <p className="font-semibold">Sunset</p>
              <p className="mt-1 text-xs text-zinc-400">
                This market has been dormant for {sunsetWindow > 0n ? Math.floor(Number(sunsetWindow) / 86400) : 30}+
                days. The ETX reserve has been recycled into the shared pool. Existing holders can
                still sell, but no new buys are recommended.
              </p>
            </div>
          )}

          {/* Provenance */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <h3 className="text-sm font-semibold text-zinc-100">Provenance</h3>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Token contract</dt>
                <dd className="break-all font-mono text-zinc-200">{market.token}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Researcher</dt>
                <dd className="break-all font-mono text-zinc-200">{market.researcher}</dd>
              </div>
            </dl>
          </div>
        </div>

        {/* Right column — buy/sell */}
        <div className="lg:col-span-1">
          <BuySellCard market={market} />
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-[10px] uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-sm text-zinc-100">{value}</div>
    </div>
  );
}
