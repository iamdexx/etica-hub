/**
 * Single-goal detail endpoint.
 *
 * GET /api/labs/goals/[id] — returns the goal record + recent attached
 * job ids + live moderation status / tallies for both the goal and its
 * recent runs. Hidden goals (`hidden` / `operator-hidden`) are returned
 * but flagged so the UI can render a placeholder; the public list view
 * filters them out at /api/labs/goals.
 */
import { getGoal, listGoalJobIds, summariseGoal } from '@/lib/labs/goal-store';
import { getStatus, readTallies } from '@/lib/labs/moderation-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const goal = await getGoal(id);
  if (!goal) return json({ error: 'Goal not found.' }, { status: 404 });

  const [jobIds, modStatus, tallies] = await Promise.all([
    listGoalJobIds(id, 40).catch(() => [] as string[]),
    getStatus('goal', id).catch(() => goal.moderation),
    readTallies('goal', id).catch(() => ({
      flagWeight: 0n,
      vouchWeight: 0n,
      flagVoters: 0,
      vouchVoters: 0,
      flagWallets: [] as string[],
      vouchWallets: [] as string[],
    })),
  ]);

  return json({
    goal: summariseGoal(goal),
    moderation: {
      status: modStatus,
      flagWeight: tallies.flagWeight.toString(),
      vouchWeight: tallies.vouchWeight.toString(),
      flagVoters: tallies.flagVoters,
      vouchVoters: tallies.vouchVoters,
    },
    jobIds,
  });
}
