/**
 * Admin endpoint: strips PDB blobs from all stored jobs to free Redis
 * memory. PDB data is the biggest memory consumer (~30KB per blob, up
 * to 4 per job). After stripping, jobs retain all metadata, candidates,
 * and analysis — just not the raw 3D structure data.
 *
 * POST /api/labs/admin/purge-pdb
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   returns: { purged: number, savedBytes: number }
 */

import { NextRequest } from 'next/server';

import { labsQueue } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  const queue = labsQueue();
  const entries = await queue.recent(50);

  let purged = 0;
  let savedBytes = 0;

  for (const entry of entries) {
    const job = await queue.get(entry.id);
    if (!job) continue;
    if (!job.result?.pdbBySequenceIndex) continue;

    const pdbKeys = Object.keys(job.result.pdbBySequenceIndex);
    if (!pdbKeys.length) continue;

    // Calculate bytes saved
    const pdbSize = JSON.stringify(job.result.pdbBySequenceIndex).length;

    // Strip all PDB data
    job.result.pdbBySequenceIndex = {};

    // Also trim events to 30 most recent
    if (job.events.length > 30) {
      job.events = job.events.slice(-30);
    }

    try {
      await queue.put(job);
      purged += 1;
      savedBytes += pdbSize;
    } catch (err) {
      // If we can't even write the stripped version, skip
      console.error(`[purge-pdb] Failed to write stripped job ${job.id}:`, err);
    }
  }

  return json({ purged, savedBytes, totalChecked: entries.length });
}
