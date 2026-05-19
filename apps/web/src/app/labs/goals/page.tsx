/**
 * Public list of EticaLabs research goals.
 *
 * Long-running research objectives. Each card links to its detail page
 * where the trajectory + related goals + community moderation surface
 * live.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ModerationBadge } from '@/components/labs/ModerationBadge';
import type { LabsGoalSummary } from '@/lib/labs/goal';

type GoalsResponse = { goals?: LabsGoalSummary[] };

function relativeTime(ms: number): string {
  if (!ms) return '—';
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function LabsGoalsPage(): JSX.Element {
  const [goals, setGoals] = useState<LabsGoalSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/labs/goals', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Goals unavailable (${res.status})`);
      const data = (await res.json()) as GoalsResponse;
      setGoals(data.goals ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Goals unavailable');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Research goals
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-white/65">
            Persistent biomedical research objectives. Each goal aggregates many Autopilot
            runs and shares context with related goals so iterations build on prior work.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/labs"
            className="rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
          >
            + Create a goal
          </Link>
          <Link
            href="/labs/moderation"
            className="rounded-full border border-white/10 bg-transparent px-4 py-2 text-sm font-medium text-white/65 transition-colors hover:border-white/20 hover:text-white"
          >
            Moderation log
          </Link>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {loaded && goals.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-base font-medium text-white">No goals yet.</p>
          <p className="mt-2 text-sm text-white/60">
            Head to{' '}
            <Link href="/labs" className="text-brand-accent hover:underline">
              /labs
            </Link>{' '}
            to create the first one.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {goals.map((g) => (
          <Link
            key={g.id}
            href={`/labs/goals/${g.id}`}
            className="group flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-medium text-white group-hover:text-white">
                {g.title}
              </h2>
              <ModerationBadge status={g.moderation} />
            </div>
            {g.description && (
              <p className="line-clamp-3 text-sm text-white/65">{g.description}</p>
            )}
            {g.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {g.keywords.slice(0, 6).map((k) => (
                  <span
                    key={k}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-white/55"
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/5 pt-3 text-[11px] text-white/55">
              <span>
                {g.runCount} run{g.runCount === 1 ? '' : 's'}
              </span>
              <span>last run {relativeTime(g.lastRunAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
