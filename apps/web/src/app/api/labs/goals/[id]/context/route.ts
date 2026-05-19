/**
 * Worker-facing goal context endpoint.
 *
 * GET /api/labs/goals/[id]/context
 *   header: x-labs-worker-token = LABS_AUTOPILOT_TOKEN
 *
 * Returns the prior best candidates from this goal's previous runs plus
 * top related-goal candidates so the Autopilot worker can seed its
 * planner with accumulated cross-goal knowledge instead of starting
 * fresh on every tick.
 */
import { NextRequest } from 'next/server';

import {
  getGoal,
  listGoalJobIds,
  relatedGoalIds,
  summariseGoal,
} from '@/lib/labs/goal-store';
import type {
  GoalContext,
  GoalContextCandidate,
  RelatedGoalContext,
} from '@/lib/labs/goal';
import type { LabsJob, LabsCandidateResult } from '@/lib/labs/job';
import { labsQueue } from '@/lib/labs/queue';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function pickBest(job: LabsJob): LabsCandidateResult | undefined {
  const cands = job.result?.candidates;
  if (!cands || !cands.length) return undefined;
  let best: LabsCandidateResult | undefined;
  for (const c of cands) {
    if (!c.folded) continue;
    if (!best) {
      best = c;
      continue;
    }
    const a = typeof c.score === 'number' ? c.score : -Infinity;
    const b = typeof best.score === 'number' ? best.score : -Infinity;
    if (a > b) best = c;
  }
  return best ?? cands[0];
}

function asContextCandidate(job: LabsJob): GoalContextCandidate | null {
  const best = pickBest(job);
  if (!best) return null;
  return {
    jobId: job.id,
    jobPrompt: job.prompt,
    sequence: best.sequence,
    rationale: best.rationale,
    analysis: best.analysis,
    score: best.score,
    folded: best.folded,
    at: job.updatedAt,
  };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  const { id } = await ctx.params;
  const goal = await getGoal(id);
  if (!goal) return json({ error: 'Goal not found.' }, { status: 404 });

  const queue = labsQueue();
  const jobIds = await listGoalJobIds(id, 8).catch(() => [] as string[]);
  const priorJobs = await Promise.all(jobIds.map((j) => queue.get(j)));
  const priorCandidates = priorJobs
    .filter((j): j is LabsJob => !!j)
    .filter((j) => j.moderation !== 'hidden' && j.moderation !== 'operator-hidden')
    .map(asContextCandidate)
    .filter((c): c is GoalContextCandidate => c !== null)
    .slice(0, 4);

  const related = await relatedGoalIds(goal, 3).catch(() => []);
  const relatedGoals: RelatedGoalContext[] = [];
  for (const r of related) {
    const otherGoal = await getGoal(r.id);
    if (!otherGoal) continue;
    if (otherGoal.moderation === 'hidden' || otherGoal.moderation === 'operator-hidden') {
      continue;
    }
    const otherJobIds = await listGoalJobIds(r.id, 4).catch(() => [] as string[]);
    let topCandidate: GoalContextCandidate | undefined;
    for (const ojid of otherJobIds) {
      const oj = await queue.get(ojid);
      if (!oj) continue;
      if (oj.moderation === 'hidden' || oj.moderation === 'operator-hidden') continue;
      const c = asContextCandidate(oj);
      if (!c) continue;
      if (!topCandidate || (c.score ?? -Infinity) > (topCandidate.score ?? -Infinity)) {
        topCandidate = c;
      }
    }
    relatedGoals.push({
      goalId: r.id,
      title: otherGoal.title,
      overlapScore: Number(r.overlap.toFixed(4)),
      topCandidate,
    });
  }

  const payload: GoalContext = {
    goal: summariseGoal(goal),
    priorCandidates,
    relatedGoals,
  };
  return json(payload);
}
