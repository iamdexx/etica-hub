/**
 * Public verification endpoint.
 *
 * GET  /api/labs/verify?sequence=...           grade an arbitrary sequence
 * POST /api/labs/verify  { sequence, pdb? }    grade with a structure
 *
 * Anyone can re-run the exact checks the archive applies, on our data or
 * their own — the grades are deterministic arithmetic, not a model's
 * opinion, so a published grade is falsifiable.
 */

import { NextRequest, NextResponse } from 'next/server';

import { verifyCandidate, verificationSummary } from '@etica-hub/shared/labs/verify';

import { getPdbForSequence } from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SEQUENCE = 1200;
const MAX_PDB_BYTES = 2_000_000;

async function grade(sequence: string, pdb?: string | null) {
  const structure = pdb ?? (await getPdbForSequence(sequence));
  const result = verifyCandidate({ sequence, pdb: structure, folded: Boolean(structure) });
  return NextResponse.json({
    ok: true,
    sequence,
    hasStructure: Boolean(structure),
    grade: result.grade,
    penalty: result.penalty,
    summary: verificationSummary(result),
    checks: result.checks,
    metrics: result.metrics,
  });
}

export async function GET(req: NextRequest) {
  const sequence = (req.nextUrl.searchParams.get('sequence') ?? '').trim().toUpperCase();
  if (!sequence) {
    return NextResponse.json({ ok: false, error: 'sequence is required' }, { status: 400 });
  }
  if (sequence.length > MAX_SEQUENCE) {
    return NextResponse.json(
      { ok: false, error: `sequence exceeds ${MAX_SEQUENCE} residues` },
      { status: 400 },
    );
  }
  return grade(sequence);
}

export async function POST(req: NextRequest) {
  let body: { sequence?: unknown; pdb?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const sequence = typeof body.sequence === 'string' ? body.sequence.trim().toUpperCase() : '';
  const pdb = typeof body.pdb === 'string' ? body.pdb : null;
  if (!sequence) {
    return NextResponse.json({ ok: false, error: 'sequence is required' }, { status: 400 });
  }
  if (sequence.length > MAX_SEQUENCE) {
    return NextResponse.json(
      { ok: false, error: `sequence exceeds ${MAX_SEQUENCE} residues` },
      { status: 400 },
    );
  }
  if (pdb && pdb.length > MAX_PDB_BYTES) {
    return NextResponse.json({ ok: false, error: 'pdb too large' }, { status: 413 });
  }
  return grade(sequence, pdb);
}
