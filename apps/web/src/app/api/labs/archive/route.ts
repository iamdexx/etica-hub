/**
 * GET /api/labs/archive — browse & search the permanent research archive.
 *
 * Query params:
 *   ?q=TEXT         — full-text search across all fields (relevance-ranked)
 *   ?disease=NAME  — filter by disease/condition
 *   ?goalId=ID     — filter by goal
 *   ?minted=true   — only show minted entries
 *   ?minScore=0.5  — minimum best candidate fold score
 *   ?sort=date|relevance|score — sort order (default: date, or relevance if q is set)
 *   ?limit=N       — max results (default 50, max 200)
 *   ?offset=N      — pagination offset (default 0)
 *
 * Returns: { results: ArchivedResearch[], total: number, facets: {...} }
 */

import { NextRequest } from 'next/server';

import { searchArchive } from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);

  const result = await searchArchive({
    q: url.searchParams.get('q') ?? undefined,
    disease: url.searchParams.get('disease') ?? undefined,
    goalId: url.searchParams.get('goalId') ?? undefined,
    mintedOnly: url.searchParams.get('minted') === 'true',
    minScore: url.searchParams.has('minScore')
      ? Number(url.searchParams.get('minScore'))
      : undefined,
    sort: (url.searchParams.get('sort') as 'relevance' | 'date' | 'score') ?? undefined,
    limit: Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 200),
    offset: Math.max(Number(url.searchParams.get('offset') ?? '0') || 0, 0),
  });

  return Response.json(result);
}
