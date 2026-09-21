/**
 * /pools/[address] — permanent, server-rendered page for one EticaSwap pool:
 * reserves, both spot prices, 24h volume, LP supply, TVL and structured data.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAddress } from 'viem';

import { JsonLd } from '@/components/JsonLd';
import { VOLUME_WINDOW_24H_SECONDS, loadPairVolume } from '@/lib/priceApi';
import { breadcrumbJsonLd } from '@/lib/seo/jsonld';
import {
  fmtNum,
  fmtUsd,
  findPool,
  loadMarketSnapshot,
  poolName,
  poolPath,
  tokenPath,
} from '@/lib/seo/market';
import { absoluteUrl, SITE_NAME } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  if (!isAddress(address, { strict: false })) return { title: 'Pool not found' };
  const snapshot = await loadMarketSnapshot();
  const p = findPool(snapshot, address);
  if (!p) return { title: 'Pool not found' };

  const name = poolName(p);
  const title = `${name} liquidity pool on EticaSwap`;
  const description = `Live reserves, price and TVL for the ${name} pool on the Etica mainnet: ${fmtNum(p.reserve0)} ${p.token0.symbol} · ${fmtNum(p.reserve1)} ${p.token1.symbol} · TVL ${fmtUsd(p.tvlUsd)}.`;
  const url = absoluteUrl(poolPath(p));
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: SITE_NAME, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function PoolPage({ params }: Params): Promise<JSX.Element> {
  const { address } = await params;
  if (!isAddress(address, { strict: false })) notFound();

  const snapshot = await loadMarketSnapshot();
  const p = findPool(snapshot, address);
  if (!p) notFound();

  const volume = await loadPairVolume(p.address, VOLUME_WINDOW_24H_SECONDS).catch(() => null);
  const name = poolName(p);
  const url = absoluteUrl(poolPath(p));
  const vol0 = volume ? Number(volume.summary.volume0) / 10 ** p.token0.decimals : null;
  const vol1 = volume ? Number(volume.summary.volume1) / 10 ** p.token1.decimals : null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `${name} pool reserves`,
    description: `On-chain reserves, spot price and 24h swap volume of the EticaSwap ${name} pool (${p.address}) on Etica mainnet.`,
    url,
    identifier: p.address,
    creator: { '@type': 'Organization', name: SITE_NAME, url: absoluteUrl('/') },
    isAccessibleForFree: true,
    dateModified: new Date(p.lastSyncTs * 1000).toISOString(),
    distribution: {
      '@type': 'DataDownload',
      encodingFormat: 'application/json',
      contentUrl: absoluteUrl(`/api/v1/pairs/${p.address}`),
    },
    variableMeasured: [
      { '@type': 'PropertyValue', name: `${p.token0.symbol} reserve`, value: p.reserve0 },
      { '@type': 'PropertyValue', name: `${p.token1.symbol} reserve`, value: p.reserve1 },
      ...(p.tvlUsd !== null ? [{ '@type': 'PropertyValue', name: 'TVL', value: p.tvlUsd, unitCode: 'USD' }] : []),
    ],
  };

  return (
    <article className="mx-auto max-w-4xl space-y-6">
      <JsonLd data={jsonLd} />
      <JsonLd data={breadcrumbJsonLd([['EticaHub', '/'], ['Pools', '/pools'], [name, poolPath(p)]])} />

      <nav className="text-xs text-white/45">
        <Link href="/pools" className="hover:text-white/80">
          Pools
        </Link>
        {' / '}
        <span className="text-white/70">{name}</span>
      </nav>

      <header className="space-y-2">
        <p className="text-[11px] uppercase tracking-wider text-white/45">EticaSwap V2 pool · Etica mainnet</p>
        <h1 className="text-2xl font-semibold text-white/95">{name}</h1>
        <p className="font-mono text-xs text-white/50">{p.address}</p>
        <p className="text-sm text-white/65">
          Constant-product pool between{' '}
          <Link href={tokenPath(p.token0)} className="text-emerald-200/80 hover:text-emerald-200">
            {p.token0.name}
          </Link>{' '}
          and{' '}
          <Link href={tokenPath(p.token1)} className="text-emerald-200/80 hover:text-emerald-200">
            {p.token1.name}
          </Link>
          . Liquidity providers earn the swap fee on every trade routed through this pair.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="TVL" value={fmtUsd(p.tvlUsd)} sub={p.tvlEtx !== null ? `${fmtNum(p.tvlEtx)} ETX` : undefined} />
        <Stat label={`1 ${p.token0.symbol} =`} value={`${fmtNum(p.price0In1, 6)} ${p.token1.symbol}`} />
        <Stat label={`1 ${p.token1.symbol} =`} value={`${fmtNum(p.price1In0, 6)} ${p.token0.symbol}`} />
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Card label="Reserves">
          <dl className="space-y-1 text-xs">
            <Row k={p.token0.symbol} v={fmtNum(p.reserve0, 4)} />
            <Row k={p.token1.symbol} v={fmtNum(p.reserve1, 4)} />
            <Row k="LP token supply" v={fmtNum(p.lpSupply, 4)} />
            <Row k="Last sync" v={new Date(p.lastSyncTs * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'} />
          </dl>
        </Card>
        <Card label="24h volume">
          {volume ? (
            <dl className="space-y-1 text-xs">
              <Row k={p.token0.symbol} v={fmtNum(vol0, 4)} />
              <Row k={p.token1.symbol} v={fmtNum(vol1, 4)} />
              <Row k="Swaps" v={String(volume.summary.swapCount)} />
              <Row k="Blocks scanned" v={`${volume.fromBlock.toString()} – ${volume.toBlock.toString()}`} />
            </dl>
          ) : (
            <p className="text-xs text-white/50">Volume scan unavailable.</p>
          )}
        </Card>
      </section>

      <footer className="flex flex-wrap gap-3 border-t border-white/10 pt-4 text-xs">
        <Link href="/swap" className="text-emerald-200/80 hover:text-emerald-200">
          Swap {p.token0.symbol} ↔ {p.token1.symbol} →
        </Link>
        <Link href="/pool" className="text-emerald-200/80 hover:text-emerald-200">
          Add liquidity →
        </Link>
        <Link href={`/explorer/address/${p.address}`} className="text-emerald-200/80 hover:text-emerald-200">
          Pool contract →
        </Link>
        <a
          href={absoluteUrl(`/api/v1/pairs/${p.address}`)}
          className="ml-auto text-white/40 hover:text-white/70"
        >
          JSON
        </a>
      </footer>
    </article>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="mt-1 font-mono text-lg text-white/90">{value}</div>
      {sub && <div className="text-xs text-white/45">{sub}</div>}
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

function Row({ k, v }: { k: string; v: React.ReactNode }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/45">{k}</dt>
      <dd className="break-all text-right font-mono text-white/80">{v}</dd>
    </div>
  );
}
