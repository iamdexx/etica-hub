/**
 * Public moderator dashboard for EticaLabs.
 *
 * Anyone can browse the queue. Casting a flag or vouch still requires
 * a wallet on chain 61803 holding ≥ 100 stETX — the same gate every
 * other moderation surface uses. The dashboard polls
 * /api/labs/moderation/queue every 10s and surfaces both goals and
 * jobs in one place, sorted by signal so the highest-impact items
 * float to the top.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';

import { ModerationBadge } from '@/components/labs/ModerationBadge';
import { signVote } from '@/lib/labs/client-sig';
import { FLAG_REASONS, type FlagReason, type ModerationStatus } from '@/lib/labs/moderation';

type Filter = 'all' | 'goals' | 'jobs' | 'flagged';

interface QueueEntry {
  kind: 'goal' | 'job';
  id: string;
  title: string;
  description?: string;
  prompt?: string;
  status: ModerationStatus;
  createdAt: number;
  updatedAt: number;
  submitter?: string;
  tallies: {
    flagWeight: string;
    vouchWeight: string;
    flagVoters: number;
    vouchVoters: number;
  };
  signal: number;
}

interface QueueResponse {
  entries: QueueEntry[];
  counts: { total: number; flagged: number; hidden: number };
}

const REFRESH_MS = 10_000;

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

function formatStetx(weiStr: string): string {
  try {
    const wei = BigInt(weiStr);
    const whole = wei / 10n ** 18n;
    return whole.toLocaleString('en-US');
  } catch {
    return '0';
  }
}

function targetHref(entry: QueueEntry): string {
  return entry.kind === 'goal' ? `/labs/goals/${entry.id}` : `/labs/feed/${entry.id}`;
}

export default function ModerationDashboardPage(): JSX.Element {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reasonByEntry, setReasonByEntry] = useState<Record<string, FlagReason>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/labs/moderation/queue?filter=${filter}&limit=80`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`queue ${res.status}`);
      const json = (await res.json()) as QueueResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const vote = useCallback(
    async (entry: QueueEntry, action: 'flag' | 'vouch') => {
      if (!isConnected || !address || !walletClient) {
        setError('Connect a wallet on chain 61803 holding ≥ 100 stETX to vote.');
        return;
      }
      const key = `${entry.kind}:${entry.id}`;
      const reason = action === 'flag' ? reasonByEntry[key] ?? 'off-topic' : undefined;
      setBusyId(key + ':' + action);
      setError(null);
      setNotice(null);
      try {
        const sig = await signVote({
          action,
          targetType: entry.kind,
          targetId: entry.id,
          reason,
          wallet: address,
          walletClient,
        });
        const res = await fetch('/api/labs/moderation/vote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            targetType: entry.kind,
            targetId: entry.id,
            wallet: sig.wallet,
            signature: sig.signature,
            issuedAt: sig.issuedAt,
            ...(action === 'flag' ? { reason } : {}),
          }),
        });
        const body = (await res.json()) as { error?: string; newStatus?: string };
        if (!res.ok) throw new Error(body.error ?? `vote ${res.status}`);
        setNotice(
          action === 'flag'
            ? `Flag recorded${body.newStatus ? ` (status: ${body.newStatus})` : ''}.`
            : `Vouch recorded${body.newStatus ? ` (status: ${body.newStatus})` : ''}.`,
        );
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Vote failed.');
      } finally {
        setBusyId(null);
      }
    },
    [isConnected, address, walletClient, reasonByEntry, load],
  );

  const filters: Array<{ key: Filter; label: string }> = useMemo(
    () => [
      { key: 'all', label: 'All' },
      { key: 'goals', label: 'Goals' },
      { key: 'jobs', label: 'Jobs' },
      { key: 'flagged', label: 'Flagged' },
    ],
    [],
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">
            EticaLabs · community
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">Moderation</h1>
          <p className="mt-1 max-w-2xl text-sm text-white/60">
            Browse every goal and job ordered by community signal. Flag or vouch with your
            wallet — weight = stETX balance (≥ 100 minimum, soft-capped at 100k). Stake at{' '}
            <Link href="/stake" className="underline decoration-white/30 underline-offset-2 hover:text-white">
              /stake
            </Link>{' '}
            to earn moderation rights.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-white/65">
          <Link
            href="/labs/feed"
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 transition-colors hover:border-white/25 hover:text-white"
          >
            ← Back to feed
          </Link>
          <Link
            href="/labs/admin/moderation"
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 transition-colors hover:border-white/25 hover:text-white"
          >
            Operator view
          </Link>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={
                'rounded-full border px-3 py-1.5 text-xs transition-colors ' +
                (filter === f.key
                  ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100'
                  : 'border-white/10 bg-white/[0.04] text-white/70 hover:border-white/25 hover:text-white')
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        {data?.counts && (
          <div className="text-xs text-white/55">
            {data.counts.total} items · {data.counts.flagged} flagged · {data.counts.hidden} hidden
          </div>
        )}
      </div>

      {(notice || error) && (
        <div
          className={
            'mb-4 rounded-lg border px-3 py-2 text-xs ' +
            (error
              ? 'border-rose-400/30 bg-rose-500/10 text-rose-200'
              : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100')
          }
        >
          {error ?? notice}
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-white/55">Loading queue…</p>
      ) : !data?.entries.length ? (
        <p className="text-sm text-white/55">No items match this filter.</p>
      ) : (
        <ul className="space-y-3">
          {data.entries.map((entry) => {
            const key = `${entry.kind}:${entry.id}`;
            const text = entry.kind === 'goal' ? entry.description ?? '' : entry.prompt ?? '';
            const reason = reasonByEntry[key] ?? 'off-topic';
            const busyFlag = busyId === key + ':flag';
            const busyVouch = busyId === key + ':vouch';
            return (
              <li
                key={key}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
                        {entry.kind}
                      </span>
                      <ModerationBadge status={entry.status} />
                      <span className="text-[11px] text-white/45">
                        updated {relativeTime(entry.updatedAt)}
                      </span>
                    </div>
                    <Link
                      href={targetHref(entry)}
                      className="mt-2 block text-base font-medium text-white hover:text-emerald-200"
                    >
                      {entry.title || (entry.kind === 'goal' ? 'Untitled goal' : 'Untitled job')}
                    </Link>
                    {text && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/70">
                        {text}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-white/55">
                      <span>
                        <span className="text-rose-200">Flags:</span> {entry.tallies.flagVoters}{' '}
                        voters · {formatStetx(entry.tallies.flagWeight)} stETX
                      </span>
                      <span>
                        <span className="text-emerald-200">Vouches:</span>{' '}
                        {entry.tallies.vouchVoters} voters ·{' '}
                        {formatStetx(entry.tallies.vouchWeight)} stETX
                      </span>
                    </div>
                  </div>
                  <div className="flex w-full shrink-0 flex-col gap-2 sm:w-64">
                    <select
                      value={reason}
                      onChange={(e) =>
                        setReasonByEntry((m) => ({
                          ...m,
                          [key]: e.target.value as FlagReason,
                        }))
                      }
                      className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-white/30"
                    >
                      {FLAG_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => vote(entry, 'flag')}
                        className="flex-1 rounded-full border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
                      >
                        {busyFlag ? 'Signing…' : 'Flag'}
                      </button>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => vote(entry, 'vouch')}
                        className="flex-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        {busyVouch ? 'Signing…' : 'Vouch'}
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
