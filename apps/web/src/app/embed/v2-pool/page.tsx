import type { Metadata } from 'next';
import { isAddress } from 'viem';
import { V2PoolWidget } from '@/components/embed/V2PoolWidget';
import { resolveWidgetPool } from '@/lib/widget/poolKeys';
import { listWidgetPools } from '@/lib/widget/pools';

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
 *   /embed/v2-pool?pair=<key|address>&ref=0xHostWallet&theme=dark|light
 *
 * `pair` is `base-quote` (`egaz-usdc.e`, `eti-etx`, `stetx-etx`, …) or a pool
 * address; the original `egaz` / `eti` keys keep working. Every pool on the
 * standalone factory is offered, so a pool someone creates later shows up
 * here without a code change.
 */
export default async function EmbedV2PoolPage({ searchParams }: Props) {
  const sp = await searchParams;
  const pools = await listWidgetPools();
  const initial = resolveWidgetPool(pools, first(sp.pair)) ?? pools[0] ?? null;
  const refParam = first(sp.ref)?.trim();
  const ref = refParam && isAddress(refParam, { strict: false }) ? refParam : null;
  const theme = first(sp.theme) === 'light' ? 'light' : 'dark';
  return <V2PoolWidget pools={pools} initialPool={initial?.address ?? null} referrer={ref} theme={theme} />;
}
