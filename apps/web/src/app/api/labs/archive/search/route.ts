/**
 * POST /api/labs/archive/search — find prior art for a research prompt.
 *
 * Called by the autopilot worker before planning to inject context from
 * previously completed research. This is what makes the pipeline cascade:
 * new research always builds on old findings.
 *
 * Body: { keywords: string[], limit?: number }
 * Returns: { results: ArchivedResearch[] }
 */

import { NextRequest } from 'next/server';

import { searchPriorArt } from '@/lib/labs/archive';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });

  let body: { keywords?: unknown; limit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((k): k is string => typeof k === 'string').slice(0, 20)
    : [];

  if (keywords.length === 0) {
    return Response.json({ results: [] });
  }

  const limit = Math.min(Number(body.limit) || 5, 20);
  const results = await searchPriorArt(keywords, limit);

  return Response.json({ results });
}
