import { fetchWatcherStatuses, WATCHER_REPO, type WatcherState } from '@/lib/bridge-watchers';

const TONE: Record<WatcherState, { dot: string; text: string; label: string }> = {
  ok: { dot: 'bg-emerald-400', text: 'text-emerald-200', label: 'Healthy' },
  running: { dot: 'bg-sky-400 animate-pulse', text: 'text-sky-200', label: 'Running' },
  late: { dot: 'bg-amber-400', text: 'text-amber-200', label: 'Overdue' },
  failed: { dot: 'bg-rose-500', text: 'text-rose-200', label: 'Failing' },
  unknown: { dot: 'bg-white/30', text: 'text-white/50', label: 'Unknown' },
};

function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export async function BridgeWatcherBoard(): Promise<JSX.Element> {
  const now = Date.now();
  const watchers = await fetchWatcherStatuses(now);
  const allOk = watchers.every((w) => w.state === 'ok' || w.state === 'running');

  return (
    <div className="p-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-widest text-white/40">Watcher bots</div>
        <span className={`text-xs ${allOk ? 'text-emerald-300' : 'text-amber-300'}`}>
          {allOk ? 'All loops on schedule' : 'Attention needed'}
        </span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {watchers.map((w) => {
          const t = TONE[w.state];
          return (
            <div key={w.id} className="rounded-xl border border-white/10 bg-black/25 p-3">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${t.dot}`} />
                <span className="text-sm font-semibold text-white">{w.label}</span>
                <span className={`ml-auto text-[11px] ${t.text}`}>{t.label}</span>
              </div>
              <p className="mt-2 text-[11px] leading-4 text-white/50">{w.description}</p>
              <div className="mt-2 flex items-center justify-between text-[11px] text-white/45">
                <span>every {w.cadenceMinutes} m · last {ago(w.lastRunAt, now)}</span>
                {w.runUrl && (
                  <a href={w.runUrl} target="_blank" rel="noopener noreferrer" className="hover:text-white/80">
                    run #{w.runNumber} ↗
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-white/35">
        Source: GitHub Actions in{' '}
        <a
          href={`https://github.com/${WATCHER_REPO}/actions`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-white/20 hover:text-white/70"
        >
          {WATCHER_REPO}
        </a>
        . Failures and stale runs page the ops Telegram channel automatically.
      </p>
    </div>
  );
}
