import type { MetadataRoute } from 'next';
import { getAddress } from 'viem';

import { listArchive } from '@/lib/labs/archive';
import { fetchAllPairs } from '@/lib/priceApi';
import { diseasePath, listDiseases } from '@/lib/seo/labs';
import { TOKEN_IDS } from '@/lib/seo/market';
import { absoluteUrl } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATIC_ROUTES: Array<[path: string, priority: number, freq: MetadataRoute.Sitemap[number]['changeFrequency']]> = [
  ['/', 1, 'daily'],
  ['/swap', 0.8, 'weekly'],
  ['/pool', 0.7, 'weekly'],
  ['/stake', 0.7, 'weekly'],
  ['/farms', 0.6, 'weekly'],
  ['/bridge', 0.8, 'weekly'],
  ['/research', 0.7, 'daily'],
  ['/research-markets', 0.7, 'daily'],
  ['/labs', 0.9, 'daily'],
  ['/labs/archive', 0.9, 'hourly'],
  ['/labs/feed', 0.7, 'hourly'],
  ['/labs/goals', 0.6, 'daily'],
  ['/labs/market', 0.6, 'daily'],
  ['/labs/diseases', 0.8, 'daily'],
  ['/tokens', 0.8, 'hourly'],
  ['/pools', 0.8, 'hourly'],
  ['/explorer', 0.6, 'hourly'],
  ['/status', 0.5, 'hourly'],
  ['/whitepaper', 0.5, 'monthly'],
];

const MAX_ARCHIVE_URLS = 2_000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = STATIC_ROUTES.map(([path, priority, changeFrequency]) => ({
    url: absoluteUrl(path),
    lastModified: now,
    changeFrequency,
    priority,
  }));

  for (const id of TOKEN_IDS) {
    entries.push({ url: absoluteUrl(`/tokens/${id}`), lastModified: now, changeFrequency: 'hourly', priority: 0.7 });
  }

  try {
    const pairs = await fetchAllPairs();
    for (const p of pairs) {
      entries.push({
        url: absoluteUrl(`/pools/${getAddress(p.address)}`),
        lastModified: new Date(p.blockTimestampLast * 1000),
        changeFrequency: 'hourly',
        priority: 0.7,
      });
    }
  } catch (err) {
    console.error('[sitemap] pair listing failed:', err instanceof Error ? err.message : err);
  }

  try {
    const diseases = await listDiseases();
    for (const d of diseases) {
      entries.push({ url: absoluteUrl(diseasePath(d.slug)), lastModified: now, changeFrequency: 'daily', priority: 0.7 });
    }
  } catch (err) {
    console.error('[sitemap] disease listing failed:', err instanceof Error ? err.message : err);
  }

  try {
    const archive = await listArchive(MAX_ARCHIVE_URLS, 0);
    for (const r of archive) {
      entries.push({
        url: absoluteUrl(`/labs/archive/${encodeURIComponent(r.id)}`),
        lastModified: new Date(r.completedAt),
        changeFrequency: 'monthly',
        priority: 0.6,
      });
    }
  } catch (err) {
    console.error('[sitemap] archive listing failed:', err instanceof Error ? err.message : err);
  }

  return entries;
}
