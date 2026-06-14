/**
 * GET /api/labs/mintable — open-market (tier-2) discoveries.
 *
 * Returns research whose 24h originator-exclusive window has lapsed but
 * whose 7-day open-market window has not, and which has not yet been
 * minted. These are the discoveries anyone may mint or branch from in the
 * "Mintable" section on /labs.
 *
 * Each entry carries the data the Mint + Branch actions need:
 *   - jobId + candidateIndex  → /api/labs/mint/attest + branch-from-candidate
 *   - score, sequenceLength   → card display
 *   - completedAt, windows    → countdown to treasury forfeit
 *
 * Window math mirrors /api/labs/mint/attest exactly.
 *
 * Query: ?limit=N (default 24, max 100)
 */

import { NextRequest } from 'next/server';

import { listMintable } from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXCLUSIVE_WINDOW_MS = 24 * 60 * 60 * 1000; // tier-1 end
const MARKET_OPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // tier-2 end

export interface MintableEntry {
  archiveId: string;
  jobId: string;
  goalId?: string;
  title: string;
  disease?: string;
  submitterWallet?: string;
  candidateIndex: number;
  score: number | null;
  sequenceLength: number;
  rationale: string;
  completedAt: number;
  exclusiveUntil: number;
  marketOpenUntil: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '24') || 24, 100);
  const now = Date.now();

  let entries: Awaited<ReturnType<typeof listMintable>>;
  try {
    entries = await listMintable(now, {
      exclusiveMs: EXCLUSIVE_WINDOW_MS,
      marketMs: MARKET_OPEN_WINDOW_MS,
      limit,
    });
  } catch {
    return Response.json({ entries: [] satisfies MintableEntry[] });
  }

  const mapped: MintableEntry[] = entries.map((e) => ({
    archiveId: e.id,
    jobId: e.jobId,
    goalId: e.goalId,
    title: e.goalTitle || e.prompt || `Research ${e.jobId}`,
    disease: e.disease,
    submitterWallet: e.submitterWallet,
    candidateIndex: e.bestCandidate?.index ?? 0,
    score: typeof e.bestCandidate?.score === 'number' ? e.bestCandidate.score : null,
    sequenceLength: e.bestCandidate?.sequence?.length ?? 0,
    rationale: e.bestCandidate?.rationale ?? '',
    completedAt: e.completedAt,
    exclusiveUntil: e.completedAt + EXCLUSIVE_WINDOW_MS,
    marketOpenUntil: e.completedAt + MARKET_OPEN_WINDOW_MS,
  }));

  return Response.json({ entries: mapped });
}
