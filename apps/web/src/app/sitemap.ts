import type { MetadataRoute } from 'next';

import { listArchive } from '@/lib/labs/archive';
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
