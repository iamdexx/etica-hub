/**
 * Public moderation audit log.
 *
 * GET /api/labs/moderation/log?limit=100
 *
 * Returns the most recent moderation events (flag/vouch/community-hide/
 * community-restore/operator-hide/operator-approve/operator-restore/
 * denied). Wallet addresses are returned in full — pseudonymous by
 * design, on-chain anyway.
 */
import { NextRequest } from 'next/server';

import { recentModerationLog } from '@/lib/labs/moderation-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function GET(req: NextRequest): Promise<Response> {
  const limitParam = req.nextUrl.searchParams.get('limit');
  let limit = 100;
  if (limitParam) {
    const n = Number(limitParam);
    if (Number.isFinite(n) && n > 0) limit = Math.min(500, Math.floor(n));
  }
  const events = await recentModerationLog(limit).catch(() => []);
  return json({ events });
}
