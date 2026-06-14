/**
 * "Mintable" — open-market (tier-2) discoveries on /labs.
 *
 * Lists research whose 24h originator-exclusive window has lapsed but
 * whose 7-day market window has not. Anyone can mint these into an RES
 * NFT (the fold image lands in their wallet) or branch new research from
 * them (extending the cascade). After 7 days, unminted records forfeit
 * to the treasury — each card shows a live countdown so it feels urgent
 * and fun to grab.
 */

'use client';

import { useEffect, useState } from 'react';
import type { Hex } from 'viem';

import { MintResButton } from './MintResButton';
import { BranchFromButton } from './BranchFromButton';

interface MintableEntry {
  archiveId: string;
  jobId: string;
  goalId?: string;
  title: string;
  disease?: string;
  submitterWallet?: string;
  candidateIndex: number;
  score: number | null;
  sequenceLength: number;
  rationale: string;
  completedAt: number;
  exclusiveUntil: number;
  marketOpenUntil: number;
}

function countdown(toMs: number, now: number): string {
  const s = Math.max(0, Math.floor((toMs - now) / 1000));
  if (s <= 0) return 'forfeiting…';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d >= 1) return `${d}d ${h}h left`;
  if (h >= 1) return `${h}h ${m}m left`;
  return `${m}m left`;
}

function scoreTone(score: number | null): string {
  if (score === null) return 'border-white/15 bg-white/[0.04] text-white/70';
  if (score >= 0.8) return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
  if (score >= 0.6) return 'border-sky-400/30 bg-sky-400/10 text-sky-200';
  return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
}

export function MintableSection(): JSX.Element | null {
  const [entries, setEntries] = useState<MintableEntry[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const load = (): void => {
      fetch('/api/labs/mintable?limit=24', { cache: 'no-store' })
        .then((r) => r.json() as Promise<{ entries?: MintableEntry[] }>)
        .then((j) => {
          if (live) setEntries(j.entries ?? []);
        })
        .catch(() => {
          if (live) setEntries([]);
        });
    };
    load();
    const reload = setInterval(load, 60_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      live = false;
      clearInterval(reload);
      clearInterval(tick);
    };
  }, []);

  // Hide the whole section until we know there is something to show, so
  // the landing page never renders an empty shell.
  if (entries === null) {
    return (
      <section className="mt-10">
        <h2 className="text-lg font-semibold text-white/90">Mintable now</h2>
        <p className="mt-1 text-sm text-white/45">Loading open-market discoveries…</p>
      </section>
    );
  }
  if (entries.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white/90">Mintable now</h2>
          <p className="mt-1 text-sm text-white/50">
            Open-market discoveries — the 24h originator window has lapsed. Mint the
            NFT or branch new research from it before it forfeits to the treasury.
          </p>
        </div>
        <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-emerald-200">
          {entries.length} open
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((e) => (
          <div
            key={e.archiveId}
            className="flex flex-col rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20"
          >
            <div className="flex items-start justify-between gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] ${scoreTone(e.score)}`}
              >
                {e.score === null ? 'unscored' : `score ${e.score.toFixed(2)}`}
              </span>
              <span className="rounded-full border border-rose-400/30 bg-rose-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-200">
                {countdown(e.marketOpenUntil, now)}
              </span>
            </div>

            <h3 className="mt-2 line-clamp-2 text-sm font-medium text-white/90">
              {e.title}
            </h3>
            {e.disease && (
              <span className="mt-1 inline-block w-fit rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
                {e.disease}
              </span>
            )}
            {e.rationale && (
              <p className="mt-2 line-clamp-3 text-xs text-white/55">{e.rationale}</p>
            )}

            <div className="mt-2 text-[11px] text-white/40">
              {e.sequenceLength} aa · candidate #{e.candidateIndex + 1}
            </div>

            <div className="mt-auto pt-3">
              <MintResButton
                jobId={e.jobId}
                candidateIndex={e.candidateIndex}
                submitter={e.submitterWallet as Hex | undefined}
                hasSequence={e.sequenceLength > 0}
              />
              <div className="mt-2">
                <BranchFromButton
                  parentJobId={e.jobId}
                  candidateIndex={e.candidateIndex}
                  compact
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
