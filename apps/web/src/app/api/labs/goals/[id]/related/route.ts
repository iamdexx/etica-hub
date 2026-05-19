/**
 * Returns up to N goals most related to the requested goal, by
 * keyword-overlap score. Hidden goals are filtered out.
 */
import { getGoal, relatedGoalIds, summariseGoal } from '@/lib/labs/goal-store';

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

  const related = await relatedGoalIds(goal, 6);
  const enriched = await Promise.all(
    related.map(async (r) => {
      const other = await getGoal(r.id);
      if (!other) return null;
      return { ...summariseGoal(other), overlap: Number(r.overlap.toFixed(4)) };
    }),
  );
  return json({ related: enriched.filter((r) => r !== null) });
}
