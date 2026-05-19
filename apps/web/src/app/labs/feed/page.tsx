/**
 * EticaLabs public research feed.
 *
 * Server-rendered list of recent autopilot runs. Reads directly from the
 * Redis-backed queue so we don't double-hop through `/api/labs/queue`. The
 * detail pages handle their own polling once a job is running.
 */

import Link from 'next/link';

import { labsQueue } from '@/lib/labs/queue';
import type { LabsFeedEntry } from '@/lib/labs/job';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const FEED_LIMIT = 50;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function StatusBadge({ status }: { status: LabsFeedEntry['status'] }) {
  const styles: Record<LabsFeedEntry['status'], string> = {
    pending: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    running: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    done: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    error: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles[status]}`}
    >
      {status === 'running' && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </span>
  );
}

export default async function LabsFeedPage() {
  let entries: LabsFeedEntry[] = [];
  let pending = 0;
  let unavailable = false;
  try {
    const queue = labsQueue();
    const [list, count] = await Promise.all([
      queue.recent(FEED_LIMIT),
      queue.pendingCount(),
    ]);
    entries = list;
    pending = count;
  } catch {
    unavailable = true;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 md:px-6">
      <section className="rounded-3xl border border-emerald-400/20 bg-[#04110d] p-6 shadow-2xl shadow-emerald-950/20">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-emerald-300">
              EticaLabs Autopilot · Public research feed
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
              What the lab is working on right now.
            </h1>
            <p className="max-w-2xl text-sm text-white/65 md:text-base">
              Anyone can submit a research goal from{' '}
              <Link href="/labs" className="text-emerald-300 underline-offset-2 hover:underline">
                /labs
              </Link>
              . A worker picks it up every ~10 minutes and runs the full Groq plan → fold → analyse
              → mutate loop. Every run is public.
            </p>
          </div>
          <div className="flex shrink-0 flex-row gap-2 sm:flex-col sm:items-end">
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-right">
              <div className="text-[10px] uppercase tracking-wider text-white/45">Queued</div>
              <div className="text-lg font-semibold text-white">{pending}</div>
            </div>
            <Link
              href="/labs"
              className="inline-flex items-center justify-center rounded-full bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink transition hover:opacity-90"
            >
              Submit a goal →
            </Link>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-white/55">
            Recent runs ({entries.length})
          </h2>
        </div>

        {unavailable && (
          <div className="rounded-2xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">
            Feed temporarily unavailable. Try again in a minute.
          </div>
        )}

        {!unavailable && entries.length === 0 && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-white/55">
            No runs yet — be the first to{' '}
            <Link href="/labs" className="text-emerald-300 underline-offset-2 hover:underline">
              submit one
            </Link>
            .
          </div>
        )}

        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Link
                href={`/labs/feed/${entry.id}`}
                className="block rounded-2xl border border-white/10 bg-[#050b09] p-4 transition hover:border-emerald-400/30 hover:bg-[#06110e]"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/45">
                      <StatusBadge status={entry.status} />
                      <span>iter {entry.iterations}</span>
                      <span>·</span>
                      <span title={new Date(entry.createdAt).toISOString()}>
                        {relativeTime(entry.createdAt)}
                      </span>
                      {entry.updatedAt !== entry.createdAt && (
                        <>
                          <span>·</span>
                          <span title={new Date(entry.updatedAt).toISOString()}>
                            updated {relativeTime(entry.updatedAt)}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="break-words text-sm text-white/85">{entry.prompt}</p>
                  </div>
                  <span className="shrink-0 self-center text-xs text-white/35">→</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
