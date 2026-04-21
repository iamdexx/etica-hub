'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps `/status` numbers fresh without a full page reload.
 *
 * Two problems this solves:
 *
 * 1. **Mobile back-forward cache (bfcache).** Safari, Brave and most mobile
 *    Chromium forks aggressively restore a frozen DOM snapshot when the user
 *    returns to a page via Back or the tab switcher. That snapshot is the HTML
 *    from the previous visit — so the on-chain numbers can be minutes or hours
 *    stale. We detect bfcache hits via `event.persisted === true` on `pageshow`
 *    and trigger a re-render of the server component.
 *
 * 2. **Users leaving the tab open.** On a sufficiently long session the
 *    rendered numbers drift from on-chain state. We poll `router.refresh()`
 *    every 30s so the server component re-runs and patches the DOM in place.
 *
 * `router.refresh()` is the right primitive here: it refetches the current
 * route's server payload (which re-executes `loadSnapshot()` on the server)
 * without reloading client-side state or scroll position.
 */
export function StatusAutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [lastRefreshMs, setLastRefreshMs] = useState<number | null>(null);
  // Incremented once a second purely to force a re-render so the
  // "last Xs ago" chip tick up visibly. Without this, the component only
  // re-renders when `lastRefreshMs` changes (i.e. every `intervalMs`),
  // so `formatRelative` would always compute ~0 and display "just now".
  const [, setTick] = useState(0);

  useEffect(() => {
    setLastRefreshMs(Date.now());

    function refresh() {
      router.refresh();
      setLastRefreshMs(Date.now());
    }

    function onPageShow(e: PageTransitionEvent) {
      // bfcache restored the page from a frozen snapshot — force a refetch.
      if (e.persisted) refresh();
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') refresh();
    }

    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const refreshTimer = window.setInterval(refresh, intervalMs);
    const tickTimer = window.setInterval(() => setTick((t) => t + 1), 1_000);

    return () => {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(refreshTimer);
      window.clearInterval(tickTimer);
    };
  }, [router, intervalMs]);

  return (
    <div className="text-right text-[11px] text-white/40">
      {lastRefreshMs !== null ? `Auto-refreshing · last ${formatRelative(lastRefreshMs)}` : null}
    </div>
  );
}

function formatRelative(ts: number): string {
  const deltaSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const mins = Math.round(deltaSec / 60);
  return `${mins}m ago`;
}
