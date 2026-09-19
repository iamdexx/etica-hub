/**
 * GET /api/v1/health
 *
 * Cheap liveness check for aggregator bots and status pages. See
 * `computeHealth()` for the `ok` semantics. The endpoint has no side
 * effects. Keep the cache window short (5s) so monitoring systems see
 * near-real-time state without hammering RPC.
 */

import { computeHealth } from '@/lib/health';
import { jsonResponse } from '@/lib/priceApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Short cache window tuned for monitoring consumers.
 *
 * We're `force-dynamic`, so Next.js ISR caching never kicks in — the only
 * layer that respects freshness is the CDN, which obeys our explicit
 * `Cache-Control` header. The default `JSON_HEADERS` apply 30s s-maxage,
 * which would gate unhealthy state behind a stale 200 for up to 90s once
 * stale-while-revalidate is considered; override it so a status page or
 * aggregator bot polling every 5s actually sees a fresh response.
 */
const HEALTH_CACHE_CONTROL = 'public, s-maxage=5, stale-while-revalidate=10';

export async function GET(): Promise<Response> {
  const body = await computeHealth();
  return jsonResponse(body, {
    status: body.ok ? 200 : 503,
    headers: { 'cache-control': HEALTH_CACHE_CONTROL },
  });
}
