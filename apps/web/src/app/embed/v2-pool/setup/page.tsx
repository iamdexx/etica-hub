import type { Metadata } from 'next';
import { V2WidgetSetup } from '@/components/embed/V2WidgetSetup';
import { SITE_URL } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Host a pool widget',
  robots: { index: false, follow: false },
};

/** Unlinked: shared with hosts directly. */
export default function EmbedSetupPage() {
  return <V2WidgetSetup siteUrl={SITE_URL} />;
}
