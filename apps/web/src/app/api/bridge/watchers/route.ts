import { fetchWatcherStatuses, WATCHER_REPO } from '@/lib/bridge-watchers';
import { jsonResponse } from '@/lib/priceApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const now = Date.now();
  const watchers = await fetchWatcherStatuses(now);
  return jsonResponse(
    { asOf: new Date(now).toISOString(), repo: WATCHER_REPO, watchers },
    { headers: { 'cache-control': 'public, s-maxage=120, stale-while-revalidate=300' } },
  );
}
