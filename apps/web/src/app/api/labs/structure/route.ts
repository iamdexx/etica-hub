/**
 * Public read-only endpoint: returns the archived Cα-only PDB for a residue
 * sequence, if one was persisted when the job folded. Used by the feed's
 * candidate cards to render the real structure for candidates whose PDB isn't
 * carried inline on the job result (the result only keeps one inline).
 *
 * GET /api/labs/structure?seq=<aminoAcidSequence>
 *   returns: { pdb: string } | { pdb: null }
 */

import { NextRequest } from 'next/server';

import { getPdbForSequence } from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MAX_SEQUENCE_LENGTH = 500;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function GET(req: NextRequest): Promise<Response> {
  const seq = req.nextUrl.searchParams.get('seq')?.trim() ?? '';
  if (!seq) return json({ error: 'seq query param is required.' }, { status: 400 });
  if (seq.length > MAX_SEQUENCE_LENGTH) {
    return json({ error: 'seq is too long.' }, { status: 400 });
  }

  let pdb: string | null = null;
  try {
    pdb = await getPdbForSequence(seq);
  } catch {
    pdb = null;
  }

  if (!pdb) return json({ pdb: null }, { status: 404 });
  return json(
    { pdb },
    { headers: { 'cache-control': 'public, max-age=300, s-maxage=300' } },
  );
}
