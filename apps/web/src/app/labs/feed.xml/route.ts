/**
 * GET /labs/feed.xml — Atom feed of the newest archived Labs discoveries.
 */

import { listArchive } from '@/lib/labs/archive';
import { atomFeed, FEED_LIMIT } from '@/lib/labs/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const records = await listArchive(FEED_LIMIT);
  return new Response(atomFeed(records), {
    headers: {
      'content-type': 'application/atom+xml; charset=utf-8',
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}
