/**
 * Public EticaLabs moderation log.
 *
 * Chronological feed of every flag / vouch / community-hide /
 * community-restore / operator-{hide,approve,restore} / denied event.
 * Wallet addresses are full (already pseudonymous on-chain); signatures
 * are stored server-side for independent verification.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import type { ModerationEvent, ModerationEventKind } from '@/lib/labs/moderation';

const KIND_STYLE: Record<ModerationEventKind, { cls: string; label: string }> = {
  flag: { cls: 'border-rose-400/30 bg-rose-400/10 text-rose-200', label: 'flag' },
  vouch: { cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200', label: 'vouch' },
  'community-hidden': {
    cls: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    label: 'community-hidden',
  },
  'community-restored': {
    cls: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    label: 'community-restored',
  },
  'community-overrode-operator': {
    cls: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    label: 'community-overrode-operator',
  },
  'operator-hidden': {
    cls: 'border-rose-500/40 bg-rose-500/15 text-rose-100',
    label: 'operator-hidden',
  },
  'operator-approved': {
    cls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
    label: 'operator-approved',
  },
  'operator-restored': {
    cls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
    label: 'operator-restored',
  },
  denied: { cls: 'border-rose-500/50 bg-rose-500/15 text-rose-100', label: 'denied' },
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

function shortWallet(w: string): string {
  if (!w || !w.startsWith('0x') || w.length < 12) return w || '—';
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

function targetHref(targetType: 'job' | 'goal', id: string): string {
  return targetType === 'goal' ? `/labs/goals/${id}` : `/labs/feed/${id}`;
}

export default function ModerationLogPage(): JSX.Element {
  const [events, setEvents] = useState<ModerationEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/labs/moderation/log?limit=200', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Log unavailable (${res.status})`);
      const data = (await res.json()) as { events?: ModerationEvent[] };
      setEvents(data.events ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Log unavailable');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Moderation log
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-white/65">
          Every community flag/vouch, every auto-hide/restore, and every operator action.
          Wallets are public on-chain. EIP-191 signatures are stored server-side so anyone
          can independently verify each action.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {loaded && events.length === 0 && !error && (
        <p className="text-sm text-white/55">No moderation activity yet.</p>
      )}

      <ol className="space-y-2">
        {events.map((e, idx) => {
          const style = KIND_STYLE[e.kind] ?? {
            cls: 'border-white/10 bg-white/[0.04] text-white/65',
            label: e.kind,
          };
          return (
            <li
              key={`${e.at}-${idx}`}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm"
            >
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${style.cls}`}
              >
                {style.label}
              </span>
              <Link
                href={targetHref(e.targetType, e.targetId)}
                className="font-mono text-xs text-white/85 hover:text-white"
              >
                {e.targetType}/{e.targetId.slice(0, 10)}
              </Link>
              <span className="font-mono text-xs text-white/55">{shortWallet(e.actor)}</span>
              {e.reason && (
                <span className="text-xs text-white/55">reason: {e.reason}</span>
              )}
              <span className="ml-auto text-xs text-white/45">{relativeTime(e.at)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
