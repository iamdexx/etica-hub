/**
 * /tokens/[id] — permanent, server-rendered page per Etica asset (etx, eti,
 * egaz, wegaz, stetx): live price, supply, contract address, the pools it
 * trades in, and structured data for search engines.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { JsonLd } from '@/components/JsonLd';
import { fetchTokenSupplyStats, formatTokenAmount } from '@/lib/priceApi';
import { breadcrumbJsonLd } from '@/lib/seo/jsonld';
import {
  TOKEN_COPY,
  TOKEN_IDS,
  fmtNum,
  fmtUsd,
  findToken,
  isTokenId,
  loadMarketSnapshot,
  poolName,
  poolPath,
  tokenPath,
} from '@/lib/seo/market';
import { absoluteUrl, SITE_NAME } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  if (!isTokenId(id)) return { title: 'Token not found' };
  const copy = TOKEN_COPY[id];
  const symbol = id === 'stetx' ? 'stETX' : id.toUpperCase();
  const title = `${symbol} price, contract & liquidity on Etica`;
  const description = `${copy.tagline}. ${copy.about}`.slice(0, 200);
  const url = absoluteUrl(`/tokens/${id}`);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: SITE_NAME, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function TokenPage({ params }: Params): Promise<JSX.Element> {
  const { id } = await params;
  if (!isTokenId(id)) notFound();

  const snapshot = await loadMarketSnapshot();
  const t = findToken(snapshot, id);
  if (!t) notFound();

  const supply = await fetchTokenSupplyStats(t.token).catch(() => null);
  const copy = TOKEN_COPY[id];
  const url = absoluteUrl(tokenPath(t.token));
  const contract = t.token.address ?? t.token.wrappedAddress;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FinancialProduct',
    name: `${t.token.name} (${t.token.symbol})`,
    alternateName: t.token.symbol,
    description: copy.about,
    url,
    identifier: contract,
    provider: { '@type': 'Organization', name: SITE_NAME, url: absoluteUrl('/') },
    ...(t.priceUsd !== null
      ? {
          offers: {
            '@type': 'Offer',
            price: t.priceUsd.toPrecision(6),
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
            url: absoluteUrl(`/swap`),
          },
        }
      : {}),
  };

  return (
    <article className="mx-auto max-w-4xl space-y-6">
      <JsonLd data={jsonLd} />
      <JsonLd
        data={breadcrumbJsonLd([
          ['EticaHub', '/'],
          ['Tokens', '/tokens'],
          [t.token.symbol, tokenPath(t.token)],
        ])}
      />

      <nav className="text-xs text-white/45">
        <Link href="/tokens" className="hover:text-white/80">
          Tokens
        </Link>
        {' / '}
        <span className="text-white/70">{t.token.symbol}</span>
      </nav>

      <header className="space-y-2">
        <p className="text-[11px] uppercase tracking-wider text-white/45">{copy.tagline}</p>
        <h1 className="text-2xl font-semibold text-white/95">
          {t.token.name} <span className="text-white/50">({t.token.symbol})</span>
        </h1>
        <p className="text-sm text-white/65">{copy.about}</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Price (USD)" value={fmtUsd(t.priceUsd)} />
        <Stat label="Price (ETX)" value={fmtNum(t.priceEtx, 6)} />
        <Stat label="Price (ETI)" value={fmtNum(t.priceEti, 6)} />
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Card label="Contract">
          <dl className="space-y-1 text-xs">
            <Row k="Chain" v="Etica mainnet · 61803" />
            <Row k={t.token.isNative ? 'Wrapped as' : 'Address'} v={contract ?? '—'} mono />
            <Row k="Decimals" v={String(t.token.decimals)} />
            {contract && (
              <Row
                k="Explorer"
                v={
                  <Link href={`/explorer/token/${contract}`} className="text-emerald-200/80 hover:text-emerald-200">
                    /explorer/token/{contract.slice(0, 10)}…
                  </Link>
                }
              />
            )}
          </dl>
        </Card>
        <Card label="Supply">
          {supply ? (
            <dl className="space-y-1 text-xs">
              <Row k="Total" v={fmtNum(Number(formatTokenAmount(supply.totalSupply, t.token.decimals)))} />
              <Row k="Circulating" v={fmtNum(Number(formatTokenAmount(supply.circulatingSupply, t.token.decimals)))} />
              <Row k="Burned" v={fmtNum(Number(formatTokenAmount(supply.burned, t.token.decimals)))} />
              {t.priceUsd !== null && (
                <Row
                  k="Market cap"
                  v={fmtUsd(Number(formatTokenAmount(supply.circulatingSupply, t.token.decimals)) * t.priceUsd)}
                />
              )}
            </dl>
          ) : (
            <p className="text-xs text-white/50">
              {t.token.isNative ? 'Native coin — supply tracked by the Etica chain.' : 'Supply unavailable.'}
            </p>
          )}
        </Card>
      </section>

      <Card label={`Liquidity pools (${t.pools.length})`}>
        {t.pools.length === 0 ? (
          <p className="text-xs text-white/50">No EticaSwap pool yet.</p>
        ) : (
          <ul className="divide-y divide-white/5 text-sm">
            {t.pools.map((p) => (
              <li key={p.address} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={poolPath(p)} className="font-medium text-white hover:text-emerald-200">
                  {poolName(p)}
                </Link>
                <span className="font-mono text-xs text-white/60">
                  {fmtNum(p.reserve0)} {p.token0.symbol} · {fmtNum(p.reserve1)} {p.token1.symbol}
                </span>
                <span className="text-xs text-white/50">TVL {fmtUsd(p.tvlUsd)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <footer className="flex flex-wrap gap-3 border-t border-white/10 pt-4 text-xs">
        <Link href="/swap" className="text-emerald-200/80 hover:text-emerald-200">
          Swap {t.token.symbol} →
        </Link>
        <Link href="/pool" className="text-emerald-200/80 hover:text-emerald-200">
          Add liquidity →
        </Link>
        {id === 'etx' && (
          <Link href="/stake" className="text-emerald-200/80 hover:text-emerald-200">
            Stake ETX →
          </Link>
        )}
        <span className="ml-auto text-white/35">
          Other tokens:{' '}
          {TOKEN_IDS.filter((x) => x !== id).map((x, i) => (
            <span key={x}>
              {i > 0 && ' · '}
              <Link href={`/tokens/${x}`} className="hover:text-white/70">
                {x === 'stetx' ? 'stETX' : x.toUpperCase()}
              </Link>
            </span>
          ))}
        </span>
      </footer>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="mt-1 font-mono text-lg text-white/90">{value}</div>
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <h2 className="mb-2 text-[11px] uppercase tracking-wider text-white/45">{label}</h2>
      <div className="text-sm text-white/80">{children}</div>
    </section>
  );
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/45">{k}</dt>
      <dd className={`break-all text-right text-white/80 ${mono ? 'font-mono' : ''}`}>{v}</dd>
    </div>
  );
}
