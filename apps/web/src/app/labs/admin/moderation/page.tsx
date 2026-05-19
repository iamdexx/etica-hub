/**
 * Operator-only EticaLabs moderation panel.
 *
 * Lists every goal + recent job with live moderation status and
 * exposes hide/approve/restore controls. Authority hierarchy:
 *
 *   1. Layer 1 hard denylist — terminal, never overridable
 *   2. Operator action — reversible by sufficient community vouches
 *   3. Community stETX-weighted vote
 *
 * Operator wallet is pinned to TREASURY_ADDRESS (or LABS_OPERATOR_ADDRESS
 * env override) and verified server-side via the same EIP-191 envelope
 * as community votes.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';

import { TREASURY_ADDRESS } from '@etica-hub/shared';

import { ModerationBadge } from '@/components/labs/ModerationBadge';
import { signVote } from '@/lib/labs/client-sig';
import type { LabsGoalSummary } from '@/lib/labs/goal';
import type { LabsFeedEntry } from '@/lib/labs/job';

type OperatorAction = 'hide' | 'approve' | 'restore';

type GoalsResponse = { goals?: LabsGoalSummary[] };

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

const OPERATOR_ENV =
  (process.env.NEXT_PUBLIC_LABS_OPERATOR_ADDRESS ?? '').trim() || TREASURY_ADDRESS;

export default function AdminModerationPage(): JSX.Element {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const isOperator =
    isConnected &&
    address &&
    address.toLowerCase() === OPERATOR_ENV.toLowerCase();

  const [goals, setGoals] = useState<LabsGoalSummary[]>([]);
  const [jobs, setJobs] = useState<LabsFeedEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [g, f] = await Promise.all([
      fetch('/api/labs/goals', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/labs/queue', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    setGoals((g as GoalsResponse).goals ?? []);
    setJobs((f as FeedResponse).entries ?? []);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  const apply = useCallback(
    async (action: OperatorAction, targetType: 'goal' | 'job', targetId: string) => {
      if (!isConnected || !address || !walletClient) {
        setError('Connect the operator wallet to act.');
        return;
      }
      if (!isOperator) {
        setError('This wallet is not the operator.');
        return;
      }
      setBusy(`${action}:${targetType}:${targetId}`);
      setError(null);
      setNotice(null);
      try {
        const reason = window.prompt(
          `Optional reason for ${action} (visible in moderation log):`,
          '',
        );
        const sig = await signVote({
          action: `operator-${action}` as const,
          targetType,
          targetId,
          reason: reason ? reason.slice(0, 140) : undefined,
          wallet: address,
          walletClient,
        });
        const res = await fetch('/api/labs/admin/moderation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            targetType,
            targetId,
            reason: reason ? reason.slice(0, 140) : undefined,
            wallet: sig.wallet,
            signature: sig.signature,
            issuedAt: sig.issuedAt,
          }),
        });
        const data = (await res.json()) as { error?: string; status?: string };
        if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
        setNotice(`${action} applied${data.status ? ` (now ${data.status})` : ''}.`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed.');
      } finally {
        setBusy(null);
      }
    },
    [isConnected, address, walletClient, isOperator, load],
  );

  const flaggedFirst = useMemo(
    () =>
      [...goals].sort((a, b) => {
        const score = (g: LabsGoalSummary) =>
          g.moderation === 'hidden' ? 0 : g.moderation === 'operator-hidden' ? 1 : 2;
        return score(a) - score(b);
      }),
    [goals],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Operator moderation
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-white/65">
          Hide stops the worker and removes the item from public feeds. Approve marks an
          item visible and pre-empts community auto-hide unless vouches are reversed by a
          sufficient flag margin. Layer 1 hard-denials are absolute. Community vouches can
          reverse any operator action when vouch-weight exceeds flag-weight by ≥ 5,000
          stETX.
        </p>
        <p className="mt-2 text-xs text-white/55">
          Operator wallet: <span className="font-mono">{OPERATOR_ENV}</span>
        </p>
        {!isConnected && (
          <p className="mt-2 text-sm text-amber-300">Connect the operator wallet.</p>
        )}
        {isConnected && !isOperator && (
          <p className="mt-2 text-sm text-rose-300">
            Connected wallet ({address}) is not the operator.
          </p>
        )}
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-200">
          {notice}
        </div>
      )}

      <section className="mb-10">
        <h2 className="text-base font-medium text-white">Goals</h2>
        <div className="mt-3 space-y-2">
          {flaggedFirst.map((g) => (
            <div
              key={g.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4"
            >
              <Link
                href={`/labs/goals/${g.id}`}
                className="min-w-0 flex-1 text-sm text-white/90 hover:text-white"
              >
                <div className="line-clamp-1 font-medium">{g.title}</div>
                <div className="text-[11px] text-white/45">
                  {g.runCount} runs · last {relativeTime(g.lastRunAt)}
                </div>
              </Link>
              <ModerationBadge status={g.moderation} />
              <div className="flex gap-2">
                <OpButton
                  action="hide"
                  busy={busy === `hide:goal:${g.id}`}
                  disabled={!isOperator}
                  onClick={() => apply('hide', 'goal', g.id)}
                />
                <OpButton
                  action="approve"
                  busy={busy === `approve:goal:${g.id}`}
                  disabled={!isOperator}
                  onClick={() => apply('approve', 'goal', g.id)}
                />
                <OpButton
                  action="restore"
                  busy={busy === `restore:goal:${g.id}`}
                  disabled={!isOperator}
                  onClick={() => apply('restore', 'goal', g.id)}
                />
              </div>
            </div>
          ))}
          {goals.length === 0 && (
            <p className="text-sm text-white/55">No goals yet.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-base font-medium text-white">Recent jobs</h2>
        <div className="mt-3 space-y-2">
          {jobs.map((j) => (
            <div
              key={j.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4"
            >
              <Link
                href={`/labs/feed/${j.id}`}
                className="min-w-0 flex-1 text-sm text-white/90 hover:text-white"
              >
                <div className="line-clamp-1">{j.prompt}</div>
                <div className="text-[11px] text-white/45">
                  {j.status} · iteration {j.iterations} · {relativeTime(j.updatedAt || j.createdAt)}
                </div>
              </Link>
              <ModerationBadge status={j.moderation} />
              <div className="flex gap-2">
                <OpButton
                  action="hide"
                  busy={busy === `hide:job:${j.id}`}
                  disabled={!isOperator}
                  onClick={() => apply('hide', 'job', j.id)}
                />
                <OpButton
                  action="approve"
                  busy={busy === `approve:job:${j.id}`}
                  disabled={!isOperator}
                  onClick={() => apply('approve', 'job', j.id)}
                />
                <OpButton
                  action="restore"
                  busy={busy === `restore:job:${j.id}`}
                  disabled={!isOperator}
                  onClick={() => apply('restore', 'job', j.id)}
                />
              </div>
            </div>
          ))}
          {jobs.length === 0 && (
            <p className="text-sm text-white/55">No recent jobs.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function OpButton({
  action,
  busy,
  disabled,
  onClick,
}: {
  action: OperatorAction;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  const cls =
    action === 'hide'
      ? 'border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
      : action === 'approve'
        ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
        : 'border-sky-400/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20';
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${cls}`}
    >
      {busy ? '…' : action}
    </button>
  );
}
