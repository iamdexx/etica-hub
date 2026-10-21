/**
 * GET /api/labs/archive — browse & search the permanent research archive.
 *
 * Query params:
 *   ?q=TEXT         — full-text search across all fields (relevance-ranked)
 *   ?disease=NAME  — filter by disease/condition
 *   ?target=NAME   — filter by molecular target (title/hypothesis/approach)
 *   ?source=NAME   — filter by academic source (pubmed|pdb|uniprot|chembl|string|kegg|alphafold)
 *   ?goalId=ID     — filter by goal
 *   ?status=published|draft|all — publication status (default published)
 *   ?grade=verified|weak|rejected — verification grade of the best candidate
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
import { researchEvidence } from '@/lib/labs/publication';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseStatus(v: string | null): 'published' | 'draft' | 'all' {
  return v === 'draft' || v === 'all' ? v : 'published';
}

function parseGrade(v: string | null): 'verified' | 'weak' | 'rejected' | undefined {
  return v === 'verified' || v === 'weak' || v === 'rejected' ? v : undefined;
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);

  const grounding = url.searchParams.get('grounding');
  const result = await searchArchive({
    grounding:
      grounding === 'checked' || grounding === 'unresolved' || grounding === 'unchecked'
        ? grounding
        : undefined,
    q: url.searchParams.get('q') ?? undefined,
    disease: url.searchParams.get('disease') ?? undefined,
    target: url.searchParams.get('target') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    goalId: url.searchParams.get('goalId') ?? undefined,
    status: parseStatus(url.searchParams.get('status')),
    grade: parseGrade(url.searchParams.get('grade')),
    mintedOnly: url.searchParams.get('minted') === 'true',
    minScore: url.searchParams.has('minScore')
      ? Number(url.searchParams.get('minScore'))
      : undefined,
    sort: (url.searchParams.get('sort') as 'relevance' | 'date' | 'score') ?? undefined,
    limit: Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 200),
    offset: Math.max(Number(url.searchParams.get('offset') ?? '0') || 0, 0),
  });

  return Response.json({
    ...result,
    results: result.results.map((r) => ({ ...r, evidence: researchEvidence(r) })),
  });
}
