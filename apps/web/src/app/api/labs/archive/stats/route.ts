/**
 * GET /api/labs/archive/stats — cumulative lifetime research metrics.
 *
 * These numbers NEVER reset to zero. They represent the total history
 * of all research ever completed on the platform.
 *
 * Returns: ArchiveStats
 */

import { getArchiveStats } from '@/lib/labs/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const stats = await getArchiveStats();
  return Response.json(stats);
}
