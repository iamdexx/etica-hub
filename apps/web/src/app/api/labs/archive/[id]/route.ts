/**
 * GET /api/labs/archive/[id] — a single archived research record (public,
 * CORS-open) so external tools can fetch the full candidate list and PDB
 * behind a feed item. `latest` resolves to the newest record.
 */

import { getArchivedResearch, listArchive } from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!/^[\w.:-]{1,128}$/.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400, headers: HEADERS });
  }
  const record =
    id === 'latest' ? ((await listArchive(1))[0] ?? null) : await getArchivedResearch(id);
  if (!record) return Response.json({ error: 'not found' }, { status: 404, headers: HEADERS });
  return Response.json(record, { headers: HEADERS });
}
