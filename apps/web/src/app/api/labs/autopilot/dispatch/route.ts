/**
 * Vercel-cron dispatcher for the EticaLabs Autopilot worker.
 *
 * GitHub Actions schedule events are unreliable on free tier — they
 * routinely get throttled or silently paused under platform load, which
 * leaves Autopilot jobs sitting in the queue indefinitely (observed
 * 2026-05-19: 2h+ gaps between scheduled ticks).
 *
 * This endpoint is invoked every minute by Vercel cron and wakes the
 * `labs-autopilot.yml` workflow via the GitHub Actions
 * `workflow_dispatch` API. Vercel cron is paid-plan and rock-solid, so
 * the worker now runs on a guaranteed cadence regardless of GitHub
 * scheduler health.
 *
 * Env:
 *   GITHUB_DISPATCH_TOKEN   fine-grained PAT with `Actions: read+write`
 *                           on the iamdexx/etica-hub repo. If unset,
 *                           the endpoint no-ops with a warning so cron
 *                           failures don't spam the logs.
 *   GITHUB_DISPATCH_REPO    "owner/repo" — default "iamdexx/etica-hub"
 *   GITHUB_DISPATCH_WORKFLOW default "labs-autopilot.yml"
 *   GITHUB_DISPATCH_REF     default "main"
 *
 * Vercel cron auth: requests come from Vercel infrastructure with a
 * specific User-Agent. We also accept a manual trigger when called with
 * the worker token in `x-labs-worker-token` for debugging. Public hits
 * without either are rejected.
 */

import { NextRequest } from 'next/server';

import { labsQueue } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const DEFAULT_REPO = 'iamdexx/etica-hub';
const DEFAULT_WORKFLOW = 'labs-autopilot.yml';
const DEFAULT_REF = 'main';

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function isVercelCron(req: NextRequest): boolean {
  // Vercel cron sets this header on the cron-triggered fetch.
  // https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
  const ua = req.headers.get('user-agent') ?? '';
  if (ua.toLowerCase().includes('vercel-cron')) return true;
  // Vercel also forwards `x-vercel-cron` on internal cron invocations.
  if (req.headers.get('x-vercel-cron')) return true;
  return false;
}

export async function GET(req: NextRequest): Promise<Response> {
  // Allow either Vercel cron or an explicit worker-token-authenticated
  // manual invocation (useful for testing from a terminal).
  const fromCron = isVercelCron(req);
  if (!fromCron) {
    const auth = requireWorkerAuth(req);
    if (!auth.ok) return json(auth.body, { status: auth.status });
  }

  // Skip the dispatch if the pending queue is empty — saves a GitHub
  // API call and reduces Actions invocations during quiet periods.
  const queue = labsQueue();
  let pending = 0;
  try {
    pending = await queue.pendingCount();
  } catch {
    // If we can't reach Redis, still dispatch (worker will diagnose).
    pending = 1;
  }
  if (pending <= 0) {
    return json({ ok: true, dispatched: false, reason: 'queue-empty' });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN ?? '';
  if (!token) {
    return json(
      {
        ok: false,
        dispatched: false,
        reason: 'GITHUB_DISPATCH_TOKEN not configured; configure on Vercel to enable dispatch',
      },
      { status: 503 },
    );
  }
  const repo = (process.env.GITHUB_DISPATCH_REPO ?? DEFAULT_REPO).trim();
  const workflow = (process.env.GITHUB_DISPATCH_WORKFLOW ?? DEFAULT_WORKFLOW).trim();
  const ref = (process.env.GITHUB_DISPATCH_REF ?? DEFAULT_REF).trim();

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(
    workflow,
  )}/dispatches`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'eticahub-labs-dispatcher',
      },
      body: JSON.stringify({ ref }),
    });
  } catch (err) {
    return json(
      {
        ok: false,
        dispatched: false,
        reason: 'github-fetch-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  // 204 No Content = success per the GitHub Actions API.
  if (res.status === 204) {
    return json({ ok: true, dispatched: true, repo, workflow, ref, pending });
  }
  const text = await res.text().catch(() => '');
  return json(
    {
      ok: false,
      dispatched: false,
      reason: 'github-dispatch-failed',
      status: res.status,
      detail: text.slice(0, 400),
    },
    { status: 502 },
  );
}

// Allow POST too for parity with manual `gh workflow run` curls.
export const POST = GET;
