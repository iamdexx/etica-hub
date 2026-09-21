/**
 * /pools — indexable list of every EticaSwap liquidity pool with live
 * reserves, spot price and TVL, linking to each pool's permalink.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { JsonLd } from '@/components/JsonLd';
import { breadcrumbJsonLd } from '@/lib/seo/jsonld';
import { fmtNum, fmtUsd, loadMarketSnapshot, poolName, poolPath, tokenPath } from '@/lib/seo/market';
import { absoluteUrl } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TITLE = 'EticaSwap liquidity pools — reserves, prices & TVL';
const DESCRIPTION =
  'Every EticaSwap liquidity pool on the Etica mainnet (chain 61803) with live on-chain reserves, spot prices, LP supply and TVL in ETX and USD.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl('/pools') },
  openGraph: { title: TITLE, description: DESCRIPTION, url: absoluteUrl('/pools'), type: 'website' },
};

export default async function PoolsPage(): Promise<JSX.Element> {
  const snapshot = await loadMarketSnapshot();
  const totalUsd = snapshot.pools.reduce((acc, p) => acc + (p.tvlUsd ?? 0), 0);

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: TITLE,
    itemListElement: snapshot.pools.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: `${poolName(p)} pool`,
      url: absoluteUrl(poolPath(p)),
    })),
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <JsonLd data={itemList} />
      <JsonLd data={breadcrumbJsonLd([['EticaHub', '/'], ['Pools', '/pools']])} />

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-white/95">EticaSwap liquidity pools</h1>
        <p className="text-sm text-white/60">{DESCRIPTION}</p>
        <p className="text-xs text-white/40">
          {snapshot.pools.length} pools · combined TVL {fmtUsd(totalUsd)} · snapshot{' '}
          {snapshot.asOf.replace('T', ' ').slice(0, 19)} UTC
        </p>
      </header>

      <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03]">
        <table className="w-full text-left text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-white/45">
            <tr>
              <th className="px-4 py-3">Pool</th>
              <th className="px-4 py-3">Reserves</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">TVL</th>
            </tr>
          </thead>
          <tbody className="text-white/80">
            {snapshot.pools.map((p) => (
              <tr key={p.address} className="border-t border-white/5">
                <td className="px-4 py-3">
                  <Link href={poolPath(p)} className="font-medium text-white hover:text-emerald-200">
                    {poolName(p)}
                  </Link>
                  <div className="font-mono text-[11px] text-white/40">{p.address}</div>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {fmtNum(p.reserve0)}{' '}
                  <Link href={tokenPath(p.token0)} className="text-white/60 hover:text-white">
                    {p.token0.symbol}
                  </Link>
                  <br />
                  {fmtNum(p.reserve1)}{' '}
                  <Link href={tokenPath(p.token1)} className="text-white/60 hover:text-white">
                    {p.token1.symbol}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  1 {p.token0.symbol} = {fmtNum(p.price0In1, 6)} {p.token1.symbol}
                </td>
                <td className="px-4 py-3 font-mono">{fmtUsd(p.tvlUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-white/45">
        <Link href="/pool" className="text-emerald-200/80 hover:text-emerald-200">Add liquidity</Link> ·{' '}
        <Link href="/farms" className="text-emerald-200/80 hover:text-emerald-200">Farm LP tokens</Link> ·{' '}
        <Link href="/tokens" className="text-emerald-200/80 hover:text-emerald-200">All tokens</Link>
      </p>
    </div>
  );
}
