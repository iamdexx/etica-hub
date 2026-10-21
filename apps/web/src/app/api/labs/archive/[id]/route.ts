/**
 * GET /api/labs/archive/[id] — a single archived research record (public,
 * CORS-open) so external tools can fetch the full candidate list and PDB
 * behind a feed item. `latest` resolves to the newest record.
 */

import { getArchivedResearch, getPdbForSequence, listArchive } from '@/lib/labs/archive';

import { researchEvidence } from '@/lib/labs/publication';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!/^[\w.:-]{1,128}$/.test(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400, headers: HEADERS });
  }
  const record =
    id === 'latest' ? ((await listArchive(1))[0] ?? null) : await getArchivedResearch(id);
  if (!record) return Response.json({ error: 'not found' }, { status: 404, headers: HEADERS });
  const query = new URL(req.url).searchParams;
  const format = query.get('format');
  const rawIndex = query.get('candidate');
  if (rawIndex !== null && !/^\d+$/.test(rawIndex)) {
    return Response.json({ error: 'invalid candidate' }, { status: 400, headers: HEADERS });
  }
  const candidates =
    rawIndex === null
      ? record.candidates
      : record.candidates.filter((c) => c.index === Number(rawIndex));
  if (rawIndex !== null && !candidates.length) {
    return Response.json({ error: 'candidate not found' }, { status: 404, headers: HEADERS });
  }
  const headers = { ...HEADERS, 'x-content-type-options': 'nosniff' };
  const filename = `${record.id.replace(/[^\w.-]/g, '_')}${rawIndex === null ? '' : `-${rawIndex}`}`;
  if (format === 'fasta') {
    const fasta = candidates
      .map(
        (c) =>
          `>${filename}|candidate=${c.index}|computational-prediction\n${c.sequence.match(/.{1,80}/g)?.join('\n') ?? ''}\n`,
      )
      .join('');
    return new Response(fasta, {
      headers: {
        ...headers,
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}.fasta"`,
      },
    });
  }
  if (format === 'pdb') {
    const candidate = rawIndex === null ? record.bestCandidate : candidates[0]!;
    const pdb =
      (await getPdbForSequence(candidate.sequence)) ??
      (candidate.sequence === record.bestCandidate.sequence ? record.bestPdb : undefined);
    if (!pdb) return Response.json({ error: 'coordinates not stored' }, { status: 404, headers });
    return new Response(
      `REMARK   1 PREDICTED CA TRACE; NOT EXPERIMENTAL OR BINDING EVIDENCE\n${pdb}`,
      {
        headers: {
          ...headers,
          'content-type': 'chemical/x-pdb',
          'content-disposition': `attachment; filename="${filename}.pdb"`,
        },
      },
    );
  }
  if (format !== null && format !== 'json') {
    return Response.json({ error: 'format must be json, fasta or pdb' }, { status: 400, headers });
  }
  return Response.json(
    { ...record, evidence: researchEvidence(record) },
    {
      headers: {
        ...headers,
        ...(format === 'json'
          ? { 'content-disposition': `attachment; filename="${filename}.json"` }
          : {}),
      },
    },
  );
}
