/**
 * GET /labs/feed.json — JSON Feed 1.1 of the newest archived Labs discoveries.
 */

import { listArchive } from '@/lib/labs/archive';
import { FEED_LIMIT, jsonFeed } from '@/lib/labs/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const records = await listArchive(FEED_LIMIT);
  return Response.json(jsonFeed(records), {
    headers: {
      'content-type': 'application/feed+json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}
