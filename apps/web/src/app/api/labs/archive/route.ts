/**
 * GET /api/labs/archive — browse the permanent research archive.
 *
 * Query params:
 *   ?limit=N       — max results (default 50, max 200)
 *   ?offset=N      — pagination offset (default 0)
 *   ?disease=NAME  — filter by disease/condition
 *   ?goalId=ID     — filter by goal
 *
 * Returns: { results: ArchivedResearch[], total: number }
 */

import { NextRequest } from 'next/server';

import {
  getArchiveCount,
  listArchive,
  listArchiveByDisease,
  listArchiveByGoal,
} from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? '0') || 0, 0);
  const disease = url.searchParams.get('disease');
  const goalId = url.searchParams.get('goalId');

  let results;
  if (disease) {
    results = await listArchiveByDisease(disease, limit);
  } else if (goalId) {
    results = await listArchiveByGoal(goalId, limit);
  } else {
    results = await listArchive(limit, offset);
  }

  const total = await getArchiveCount();

  return Response.json({ results, total });
}
