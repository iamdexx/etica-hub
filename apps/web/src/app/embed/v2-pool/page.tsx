import type { Metadata } from 'next';
import { isAddress } from 'viem';
import { V2PoolWidget, type WidgetPairKey } from '@/components/embed/V2PoolWidget';

export const metadata: Metadata = {
  title: 'EticaSwap pool widget',
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Embeddable pool widget for third-party sites (iframe). Not linked from
 * anywhere on EticaHub and excluded from robots/sitemap on purpose: the
 * standalone V2 pools live only here and on-chain.
 *
 *   /embed/v2-pool?pair=egaz|eti&ref=0xHostWallet&theme=dark|light
 */
export default async function EmbedV2PoolPage({ searchParams }: Props) {
  const sp = await searchParams;
  const pairParam = (first(sp.pair) ?? 'egaz').toLowerCase();
  const pair: WidgetPairKey = pairParam === 'eti' ? 'eti' : 'egaz';
  const refParam = first(sp.ref)?.trim();
  const ref = refParam && isAddress(refParam, { strict: false }) ? refParam : null;
  const theme = first(sp.theme) === 'light' ? 'light' : 'dark';
  return <V2PoolWidget pair={pair} referrer={ref} theme={theme} />;
}
