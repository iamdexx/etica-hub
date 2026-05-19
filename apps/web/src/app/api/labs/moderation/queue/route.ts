/**
 * Aggregated moderation queue for the public moderator dashboard.
 *
 * GET /api/labs/moderation/queue?limit=50&filter=all
 *
 * Returns recent goals + recent jobs with their current moderation
 * status and stETX-weighted tallies (flag/vouch). Items are sorted by
 * a "signal" score so the highest-impact items rise to the top:
 *
 *   signal = (flagVoters * 10) + (vouchVoters * 1) + recencyBoost
 *
 * Anyone can read this — the dashboard is public, voting itself is
 * still gated by the existing wallet/stETX requirements in
 * /api/labs/moderation/vote.
 */
import { NextRequest } from 'next/server';

import { listGoals } from '@/lib/labs/goal-store';
import type { ModerationStatus } from '@/lib/labs/moderation';
import { readTallies } from '@/lib/labs/moderation-store';
import { labsQueue } from '@/lib/labs/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Filter = 'all' | 'goals' | 'jobs' | 'flagged';

interface QueueEntry {
  kind: 'goal' | 'job';
  id: string;
  title: string;
  description?: string;
  prompt?: string;
  status: ModerationStatus;
  createdAt: number;
  updatedAt: number;
  submitter?: string;
  tallies: {
    flagWeight: string;
    vouchWeight: string;
    flagVoters: number;
    vouchVoters: number;
  };
  signal: number;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function parseFilter(v: string | null): Filter {
  if (v === 'goals' || v === 'jobs' || v === 'flagged') return v;
  return 'all';
}

function recencyBoost(at: number): number {
  // Items touched in the last hour get a small lift so fresh
  // activity is surfaced even before any community votes land.
  const ageMs = Date.now() - at;
  if (ageMs < 60 * 60 * 1000) return 5;
  if (ageMs < 24 * 60 * 60 * 1000) return 2;
  return 0;
}

function signal(flagVoters: number, vouchVoters: number, updatedAt: number): number {
  return flagVoters * 10 + vouchVoters + recencyBoost(updatedAt);
}

export async function GET(req: NextRequest): Promise<Response> {
  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitParam) ? Math.min(150, Math.max(1, Math.floor(limitParam))) : 50;
  const filter = parseFilter(req.nextUrl.searchParams.get('filter'));

  const entries: QueueEntry[] = [];

  if (filter === 'all' || filter === 'goals' || filter === 'flagged') {
    const goals = await listGoals(limit, 0).catch(() => []);
    for (const g of goals) {
      const tallies = await readTallies('goal', g.id).catch(() => null);
      if (!tallies) continue;
      entries.push({
        kind: 'goal',
        id: g.id,
        title: g.title,
        description: g.description,
        status: g.moderation,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        submitter: g.submitterWallet,
        tallies: {
          flagWeight: tallies.flagWeight.toString(),
          vouchWeight: tallies.vouchWeight.toString(),
          flagVoters: tallies.flagVoters,
          vouchVoters: tallies.vouchVoters,
        },
        signal: signal(tallies.flagVoters, tallies.vouchVoters, g.updatedAt),
      });
    }
  }

  if (filter === 'all' || filter === 'jobs' || filter === 'flagged') {
    const jobs = await labsQueue().recent(limit).catch(() => []);
    for (const j of jobs) {
      const tallies = await readTallies('job', j.id).catch(() => null);
      if (!tallies) continue;
      entries.push({
        kind: 'job',
        id: j.id,
        title: j.prompt.slice(0, 120),
        prompt: j.prompt,
        status: j.moderation ?? 'visible',
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        tallies: {
          flagWeight: tallies.flagWeight.toString(),
          vouchWeight: tallies.vouchWeight.toString(),
          flagVoters: tallies.flagVoters,
          vouchVoters: tallies.vouchVoters,
        },
        signal: signal(tallies.flagVoters, tallies.vouchVoters, j.updatedAt),
      });
    }
  }

  let filtered = entries;
  if (filter === 'flagged') {
    filtered = entries.filter(
      (e) => e.tallies.flagVoters > 0 || e.status === 'hidden' || e.status === 'operator-hidden',
    );
  }

  filtered.sort((a, b) => {
    if (b.signal !== a.signal) return b.signal - a.signal;
    return b.updatedAt - a.updatedAt;
  });

  return json(
    {
      entries: filtered.slice(0, limit),
      counts: {
        total: filtered.length,
        flagged: entries.filter((e) => e.tallies.flagVoters > 0).length,
        hidden: entries.filter(
          (e) => e.status === 'hidden' || e.status === 'operator-hidden',
        ).length,
      },
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
