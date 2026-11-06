import type { Metadata } from 'next';
import { V2WidgetSetup } from '@/components/embed/V2WidgetSetup';
import { SITE_URL } from '@/lib/site';
import { listWidgetPools } from '@/lib/widget/pools';

export const metadata: Metadata = {
  title: 'Host a pool widget',
  robots: { index: false, follow: false },
};

/** Unlinked: shared with hosts directly. */
export default async function EmbedSetupPage() {
  const pools = await listWidgetPools();
  return <V2WidgetSetup siteUrl={SITE_URL} pools={pools.map((p) => ({ key: p.key, label: p.label }))} />;
}
