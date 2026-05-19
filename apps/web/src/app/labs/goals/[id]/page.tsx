/**
 * Goal detail view.
 *
 * Shows the goal title/description/keywords, its run trajectory, the
 * top related goals (cross-link panel), live moderation tallies, and a
 * wallet-gated flag/vouch control. Operator actions live on a separate
 * /labs/admin/moderation surface.
 */
'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';

import { FlagVouchPanel } from '@/components/labs/FlagVouchPanel';
import { ModerationBadge } from '@/components/labs/ModerationBadge';
import { signSubmit } from '@/lib/labs/client-sig';
import type { LabsGoalSummary } from '@/lib/labs/goal';
import type { LabsFeedEntry } from '@/lib/labs/job';

type DetailResponse = {
  goal?: LabsGoalSummary;
  jobIds?: string[];
  moderation?: {
    status: string;
    flagWeight: string;
    vouchWeight: string;
    flagVoters: number;
    vouchVoters: number;
  };
  error?: string;
};

type RelatedResponse = {
  related?: (LabsGoalSummary & { overlap: number })[];
};

type FeedResponse = { entries?: LabsFeedEntry[] };

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

function fmtStEtxWei(wei: string): string {
  try {
    const n = BigInt(wei);
    const whole = n / 10n ** 18n;
    return `${whole.toLocaleString()} stETX`;
  } catch {
    return '0 stETX';
  }
}

export default function GoalDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const goalId = params?.id ?? '';

  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [related, setRelated] = useState<(LabsGoalSummary & { overlap: number })[]>([]);
  const [feedById, setFeedById] = useState<Map<string, LabsFeedEntry>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const loadDetail = useCallback(async () => {
    if (!goalId) return;
    try {
      const [d, r, f] = await Promise.all([
        fetch(`/api/labs/goals/${goalId}`, { cache: 'no-store' }).then((res) => res.json()),
        fetch(`/api/labs/goals/${goalId}/related`, { cache: 'no-store' }).then((res) => res.json()),
        fetch('/api/labs/queue', { cache: 'no-store' }).then((res) => res.json()),
      ]);
      setDetail(d as DetailResponse);
      setRelated((r as RelatedResponse).related ?? []);
      const entries = (f as FeedResponse).entries ?? [];
      const map = new Map<string, LabsFeedEntry>();
      for (const e of entries) map.set(e.id, e);
      setFeedById(map);
    } finally {
      setLoaded(true);
    }
  }, [goalId]);

  useEffect(() => {
    loadDetail();
    const t = setInterval(loadDetail, 15_000);
    return () => clearInterval(t);
  }, [loadDetail]);

  const goalJobs = useMemo<LabsFeedEntry[]>(() => {
    const ids = detail?.jobIds ?? [];
    return ids.map((id) => feedById.get(id)).filter((e): e is LabsFeedEntry => Boolean(e));
  }, [detail?.jobIds, feedById]);

  const handleRunAgain = useCallback(async () => {
    if (!detail?.goal) return;
    if (!isConnected || !address || !walletClient) {
      setRunError('Connect your wallet to submit research to Autopilot.');
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const prompt = detail.goal.title;
      const payload = `${detail.goal.id}|${prompt}`;
      const sig = await signSubmit({
        action: 'submit-job',
        payload,
        wallet: address,
        walletClient,
      });
      const res = await fetch('/api/labs/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt,
          goalId: detail.goal.id,
          wallet: sig.wallet,
          signature: sig.signature,
          issuedAt: sig.issuedAt,
        }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? `submit failed (${res.status})`);
      window.location.href = `/labs/feed/${data.id}`;
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      setRunning(false);
    }
  }, [detail, isConnected, address, walletClient]);

  if (!loaded) {
    return <div className="mx-auto max-w-5xl px-4 py-12 text-sm text-white/55">Loading…</div>;
  }

  if (!detail?.goal) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-12 text-sm text-white/55">
        <p className="text-base font-medium text-white">Goal not found.</p>
        <Link href="/labs/goals" className="mt-2 inline-block text-brand-accent hover:underline">
          ← Back to goals
        </Link>
      </div>
    );
  }

  const g = detail.goal;
  const m = detail.moderation;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/labs/goals"
        className="text-sm text-white/55 transition-colors hover:text-white"
      >
        ← Goals
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {g.title}
          </h1>
          {g.description && (
            <p className="mt-2 max-w-3xl text-sm text-white/65">{g.description}</p>
          )}
          {g.keywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {g.keywords.map((k) => (
                <span
                  key={k}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-white/55"
                >
                  {k}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <ModerationBadge status={m?.status as LabsGoalSummary['moderation']} />
          <button
            type="button"
            onClick={handleRunAgain}
            disabled={running}
            className="rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            {running ? 'Submitting…' : 'Run another iteration'}
          </button>
          {runError && <p className="text-xs text-rose-300">{runError}</p>}
        </div>
      </header>

      <section className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-wider text-white/45">Runs</p>
          <p className="mt-1 text-2xl font-semibold text-white">{g.runCount}</p>
          <p className="mt-1 text-xs text-white/55">
            last {relativeTime(g.lastRunAt)}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-wider text-white/45">Flag weight</p>
          <p className="mt-1 text-2xl font-semibold text-rose-200">
            {m ? fmtStEtxWei(m.flagWeight) : '—'}
          </p>
          <p className="mt-1 text-xs text-white/55">{m?.flagVoters ?? 0} voters</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-wider text-white/45">Vouch weight</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-200">
            {m ? fmtStEtxWei(m.vouchWeight) : '—'}
          </p>
          <p className="mt-1 text-xs text-white/55">{m?.vouchVoters ?? 0} voters</p>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-medium text-white">Trajectory</h2>
        {goalJobs.length === 0 ? (
          <p className="mt-2 text-sm text-white/55">
            No runs yet on this goal. Click <span className="text-white/85">Run another iteration</span>.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {goalJobs.map((entry) => (
              <Link
                key={entry.id}
                href={`/labs/feed/${entry.id}`}
                className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
              >
                <div className="flex items-center justify-between gap-2 text-[11px] text-white/55">
                  <span className="uppercase tracking-wider">{entry.status}</span>
                  <span>{relativeTime(entry.updatedAt || entry.createdAt)}</span>
                </div>
                <p className="line-clamp-3 text-sm text-white/85">{entry.prompt}</p>
                <div className="flex items-center justify-between gap-2 text-[11px] text-white/45">
                  <span>iteration {entry.iterations}</span>
                  <ModerationBadge status={entry.moderation} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-medium text-white">Related goals</h2>
        {related.length === 0 ? (
          <p className="mt-2 text-sm text-white/55">
            No related goals yet. Once other research goals share keywords with this one,
            they appear here and seed the planner with their best candidates.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/labs/goals/${r.id}`}
                className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
              >
                <p className="text-sm font-medium text-white">{r.title}</p>
                {r.description && (
                  <p className="line-clamp-2 text-xs text-white/55">{r.description}</p>
                )}
                <div className="flex items-center justify-between gap-2 text-[11px] text-white/45">
                  <span>
                    {r.runCount} run{r.runCount === 1 ? '' : 's'}
                  </span>
                  <span>overlap {(r.overlap * 100).toFixed(0)}%</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <FlagVouchPanel targetType="goal" targetId={g.id} onVoted={loadDetail} />
      </section>
    </div>
  );
}
