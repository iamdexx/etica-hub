/**
 * Public Labs Autopilot research feed.
 *
 * Reads /api/labs/queue every 5s and renders a grid of recent research
 * runs. Each card shows the prompt, status pill, iteration count, and a
 * relative timestamp. Clicking a card opens the per-job detail view at
 * /labs/feed/[id] with the full plan, candidates, and 3D structures.
 *
 * The feed is intentionally read-only and public — anyone can browse
 * what the agents are working on right now. Submission happens from
 * /labs via the "Run on Autopilot" button.
 */

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ModerationBadge } from '@/components/labs/ModerationBadge';
import type { LabsFeedEntry, LabsJobStatus } from '@/lib/labs/job';

const REFRESH_MS = 5_000;

type FeedResponse = {
  entries?: LabsFeedEntry[];
  pending?: number;
};

function relativeTime(ms: number): string {
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

function statusClasses(status: LabsJobStatus): string {
  switch (status) {
    case 'pending':
      return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
    case 'running':
      return 'border-sky-400/30 bg-sky-400/10 text-sky-200';
    case 'done':
      return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
    case 'error':
      return 'border-rose-400/30 bg-rose-400/10 text-rose-200';
    default:
      return 'border-white/15 bg-white/5 text-white/70';
  }
}

function statusLabel(status: LabsJobStatus): string {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'errored';
    default:
      return status;
  }
}

function StatusDot({ status }: { status: LabsJobStatus }) {
  const animate = status === 'pending' || status === 'running';
  return (
    <span className="relative inline-flex h-2 w-2">
      {animate && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
    </span>
  );
}

export default function LabsFeedPage(): JSX.Element {
  const [entries, setEntries] = useState<LabsFeedEntry[]>([]);
  const [pending, setPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);

  const tick = useCallback(async () => {
    try {
      const res = await fetch('/api/labs/queue', { cache: 'no-store' });
      if (!res.ok) {
        throw new Error(`Feed unavailable (${res.status})`);
      }
      const data = (await res.json()) as FeedResponse;
      setEntries(data.entries ?? []);
      setPending(data.pending ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feed unavailable');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [tick]);

  // Distinct research topics (root goals) across all visible entries.
  // Branch entries roll up to their parent topic so the chip-set shows
  // a single "Brain cancer" pill rather than one per child chain.
  const topics = new Map<string, string>();
  for (const e of entries) {
    if (!e.goalId) continue;
    const rootId =
      e.goalOrigin === 'branch' && e.parentGoalId ? e.parentGoalId : e.goalId;
    const rootTitle =
      e.goalOrigin === 'branch' && e.parentGoalTitle
        ? e.parentGoalTitle
        : e.goalTitle;
    if (!rootTitle) continue;
    if (!topics.has(rootId)) topics.set(rootId, rootTitle);
  }

  const filtered = topicFilter
    ? entries.filter((e) => {
        const rootId =
          e.goalOrigin === 'branch' && e.parentGoalId ? e.parentGoalId : e.goalId;
        return rootId === topicFilter;
      })
    : entries;

  const running = filtered.filter((e) => e.status === 'running').length;
  const queued = filtered.filter((e) => e.status === 'pending').length;
  const done = filtered.filter((e) => e.status === 'done').length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Research feed
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-white/65">
              Live view of every Autopilot run. Agents pick up prompts from the queue,
              draft a research plan, fold candidate sequences, and post results here in
              real time.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/labs/moderation"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
            >
              Moderation
            </Link>
            <Link
              href="/labs"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
            >
              <span>+</span>
              <span>Submit a goal</span>
            </Link>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-white/60">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            <span>refreshes every {REFRESH_MS / 1000}s</span>
          </span>
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-amber-200">
            {queued} queued
          </span>
          <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-sky-200">
            {running} running
          </span>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-emerald-200">
            {done} completed
          </span>
          {pending > 0 && (
            <span className="text-white/45">
              ({pending} job{pending === 1 ? '' : 's'} waiting for worker)
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {topics.size > 0 && (
        <div className="mb-5 -mx-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTopicFilter(null)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              topicFilter === null
                ? 'border-white/30 bg-white/15 text-white'
                : 'border-white/10 bg-white/[0.04] text-white/65 hover:border-white/25 hover:text-white'
            }`}
          >
            All topics ({entries.length})
          </button>
          {Array.from(topics.entries()).map(([id, title]) => {
            const count = entries.filter((e) => {
              const rootId =
                e.goalOrigin === 'branch' && e.parentGoalId ? e.parentGoalId : e.goalId;
              return rootId === id;
            }).length;
            const active = topicFilter === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTopicFilter(active ? null : id)}
                className={`max-w-[20rem] truncate rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'border-violet-400/60 bg-violet-400/15 text-violet-100'
                    : 'border-white/10 bg-white/[0.04] text-white/70 hover:border-violet-400/40 hover:text-white'
                }`}
                title={title}
              >
                {title} <span className="text-white/40">({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {loaded && entries.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-base font-medium text-white">No runs yet.</p>
          <p className="mt-2 text-sm text-white/60">
            Head to{' '}
            <Link href="/labs" className="text-brand-accent hover:underline">
              /labs
            </Link>{' '}
            and click <span className="text-white/85">Run on Autopilot</span> to start the
            first one.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((entry) => {
          const isBranch = entry.goalOrigin === 'branch';
          const topicLabel = entry.goalTitle
            ? isBranch && entry.parentGoalTitle
              ? `Branch from: ${entry.parentGoalTitle}`
              : entry.goalTitle
            : null;
          return (
            <Link
              key={entry.id}
              href={`/labs/feed/${entry.id}`}
              className="group flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${statusClasses(entry.status)}`}
                >
                  <StatusDot status={entry.status} />
                  <span>{statusLabel(entry.status)}</span>
                </span>
                <span className="text-[11px] text-white/45">
                  {relativeTime(entry.updatedAt || entry.createdAt)}
                </span>
              </div>

              {topicLabel && (
                <div className="flex items-start gap-1.5">
                  <span
                    className={`mt-0.5 inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${
                      isBranch
                        ? 'border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200'
                        : 'border-violet-400/30 bg-violet-400/10 text-violet-200'
                    }`}
                  >
                    {isBranch ? 'branch' : 'topic'}
                  </span>
                  <span className="line-clamp-2 break-words text-[12px] font-medium text-white/80">
                    {topicLabel}
                  </span>
                </div>
              )}

              <p className="whitespace-pre-wrap break-words text-sm text-white/85 group-hover:text-white">
                {entry.prompt}
              </p>

              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3 text-[11px] text-white/55">
                <span>
                  iteration {entry.iterations}
                  {entry.status === 'running' ? ' …' : ''}
                </span>
                <div className="flex items-center gap-2">
                  <ModerationBadge status={entry.moderation} />
                  <span className="font-mono text-white/40">{entry.id.slice(0, 8)}</span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
