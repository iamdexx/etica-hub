/**
 * Labs Autopilot job status endpoint.
 *
 * GET /api/labs/queue/[id]
 *   returns the full LabsJob blob (including events + result when present).
 *
 * Read-only. No auth — feed is public by design.
 */

import { NextRequest } from 'next/server';

import { labsQueue } from '@/lib/labs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return json({ error: 'Job ID is required.' }, { status: 400 });
  }

  const job = await labsQueue().get(id);
  if (!job) {
    return json({ error: 'Job not found.' }, { status: 404 });
  }

  return json({ job });
}
