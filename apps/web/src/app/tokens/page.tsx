/**
 * /tokens — indexable overview of every asset traded on EticaHub with live
 * ETX / USD prices and links to each token's permalink.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { JsonLd } from '@/components/JsonLd';
import { breadcrumbJsonLd } from '@/lib/seo/jsonld';
import { TOKEN_COPY, fmtNum, fmtUsd, isTokenId, loadMarketSnapshot, tokenPath } from '@/lib/seo/market';
import { absoluteUrl } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TITLE = 'Etica tokens — ETX, ETI, EGAZ, WEGAZ, stETX prices';
const DESCRIPTION =
  'Live on-chain prices, contract addresses and liquidity pools for every token on the Etica mainnet (chain 61803): ETX, ETI, EGAZ, WEGAZ and stETX.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl('/tokens') },
  openGraph: { title: TITLE, description: DESCRIPTION, url: absoluteUrl('/tokens'), type: 'website' },
};

export default async function TokensPage(): Promise<JSX.Element> {
  const snapshot = await loadMarketSnapshot();

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: TITLE,
    itemListElement: snapshot.tokens.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: `${t.token.name} (${t.token.symbol})`,
      url: absoluteUrl(tokenPath(t.token)),
    })),
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <JsonLd data={itemList} />
      <JsonLd data={breadcrumbJsonLd([['EticaHub', '/'], ['Tokens', '/tokens']])} />

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-white/95">Tokens on Etica</h1>
        <p className="text-sm text-white/60">{DESCRIPTION}</p>
        <p className="text-xs text-white/40">
          Prices read from EticaSwap reserves at {snapshot.asOf.replace('T', ' ').slice(0, 19)} UTC · USD via ETI/USDT and
          EGAZ/USDT anchors.
        </p>
      </header>

      <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03]">
        <table className="w-full text-left text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-white/45">
            <tr>
              <th className="px-4 py-3">Token</th>
              <th className="px-4 py-3">Price (ETX)</th>
              <th className="px-4 py-3">Price (USD)</th>
              <th className="px-4 py-3">Pools</th>
              <th className="px-4 py-3">Contract</th>
            </tr>
          </thead>
          <tbody className="text-white/80">
            {snapshot.tokens.map((t) => (
              <tr key={t.token.id} className="border-t border-white/5">
                <td className="px-4 py-3">
                  <Link href={tokenPath(t.token)} className="font-medium text-white hover:text-emerald-200">
                    {t.token.symbol}
                  </Link>
                  <div className="text-xs text-white/45">
                    {isTokenId(t.token.id) ? TOKEN_COPY[t.token.id].tagline : t.token.name}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono">{fmtNum(t.priceEtx, 6)}</td>
                <td className="px-4 py-3 font-mono">{fmtUsd(t.priceUsd)}</td>
                <td className="px-4 py-3">{t.pools.length}</td>
                <td className="px-4 py-3 font-mono text-xs text-white/55">
                  {t.token.address ?? `native · wraps to ${t.token.wrappedAddress?.slice(0, 10)}…`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-white/45">
        See also <Link href="/pools" className="text-emerald-200/80 hover:text-emerald-200">all liquidity pools</Link> ·{' '}
        <Link href="/swap" className="text-emerald-200/80 hover:text-emerald-200">swap</Link> ·{' '}
        <Link href="/stake" className="text-emerald-200/80 hover:text-emerald-200">stake ETX</Link>
      </p>
    </div>
  );
}
