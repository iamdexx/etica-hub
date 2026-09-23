/**
 * Regrade already-archived research with the objective verifier.
 *
 * POST /api/labs/archive/verify-backfill  { offset?, limit? }
 * Worker-token protected; processes one page per call (Vercel duration
 * cap) and returns the next offset so the caller can walk the archive.
 * Re-ranks each record's published best candidate the same way the live
 * archive path now does, so historical records stop headlining designs
 * that fail verification, and grounds each record's named targets and
 * citations against UniProt/PubMed (`ground: false` to skip the external
 * lookups and regrade designs only).
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  getArchiveCount,
  listArchive,
  saveArchivedResearch,
  type ArchivedResearch,
} from '@/lib/labs/archive';
import {
  pickBestCandidate,
  runGrade,
  verifyArchivedCandidates,
} from '@/lib/labs/verification';
import { groundArchivedResearch } from '@/lib/labs/grounding';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
/** Leave room inside maxDuration to serialise the response. */
const DEADLINE_MS = 50_000;

export async function POST(req: NextRequest) {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  let body: { offset?: unknown; limit?: unknown; ground?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
  const ground = body.ground !== false;

  const total = await getArchiveCount();
  const page = await listArchive(limit, offset);

  const counts = { verified: 0, weak: 0, rejected: 0 };
  let rerankedBest = 0;
  let grounded = 0;
  let ungrounded = 0;
  let groundingError: string | null = null;
  let processed = 0;
  const deadline = Date.now() + DEADLINE_MS;

  for (const record of page) {
    // External grounding lookups make per-record cost unpredictable; stop
    // short and let the caller resume rather than get killed mid-write.
    if (Date.now() > deadline) break;
    processed += 1;
    const candidates = record.candidates?.length
      ? record.candidates
      : record.bestCandidate
        ? [record.bestCandidate]
        : [];
    if (candidates.length === 0) continue;

    const verifications = await verifyArchivedCandidates(
      candidates,
      record.bestPdb,
      record.bestCandidate?.sequence,
    );
    const best = pickBestCandidate(candidates, verifications);
    if (best.index !== record.bestCandidate?.index) rerankedBest += 1;

    const updated: ArchivedResearch = {
      ...record,
      candidates: candidates.map((c) => ({ ...c, verification: verifications.get(c.index) })),
      bestCandidate: { ...best, verification: verifications.get(best.index) },
      verificationGrade: runGrade(best, verifications),
    };
    counts[updated.verificationGrade ?? 'weak'] += 1;

    if (ground && !updated.grounding) {
      const grounding = await groundArchivedResearch(updated, (msg) => {
        groundingError ??= msg;
      });
      if (grounding) {
        updated.grounding = grounding;
        if (grounding.targets.length > 0) grounded += 1;
        else ungrounded += 1;
      }
    }

    await saveArchivedResearch(updated);
  }

  const nextOffset = offset + processed;
  return NextResponse.json({
    ok: true,
    total,
    processed,
    offset,
    nextOffset: nextOffset < total && processed > 0 ? nextOffset : null,
    rerankedBest,
    counts,
    grounding: { grounded, ungrounded, error: groundingError },
  });
}
