/**
 * Live Sourcify verification status for a ResearchToken.
 *
 * Polls https://sourcify.dev/server/v2/contract/{chainId}/{address} and
 * renders one of:
 *   - "Verified ✓" (green) if Sourcify has the source
 *   - "Pending verification" (amber) if Sourcify is supported but the
 *      token hasn't been picked up by the auto-Sourcify cron yet
 *   - "Chain pending Sourcify support" (zinc) if Etica mainnet (61803)
 *      isn't yet listed by the Sourcify server — see
 *      docs/SOURCIFY_CHAIN_SUBMISSION.md
 *
 * The Sourcify server is read-only here; the auto-Sourcify GitHub Actions
 * worker is responsible for the actual POST submissions on the cron.
 */
'use client';

import { useEffect, useState } from 'react';
import type { Address } from 'viem';

type Status = 'loading' | 'verified-exact' | 'verified-match' | 'pending' | 'unsupported' | 'error';

const SOURCIFY_SERVER = (
  process.env.NEXT_PUBLIC_SOURCIFY_SERVER || 'https://sourcify.dev/server'
).replace(/\/$/, '');

const SOURCIFY_REPO =
  process.env.NEXT_PUBLIC_SOURCIFY_REPO || 'https://repo.sourcify.dev';

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || 61803);

export function SourcifyBadge({ token }: { token: Address }) {
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch(
          `${SOURCIFY_SERVER}/v2/contract/${CHAIN_ID}/${token}`,
          { cache: 'no-store' },
        );
        if (cancelled) return;
        if (res.status === 404) {
          setStatus('pending');
          return;
        }
        if (res.status === 400 || res.status === 422 || res.status === 501) {
          setStatus('unsupported');
          return;
        }
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const body = (await res.json().catch(() => null)) as
          | { match?: string; runtimeMatch?: string; creationMatch?: string }
          | null;
        const m = body?.match ?? body?.runtimeMatch ?? body?.creationMatch ?? '';
        if (m === 'exact_match' || m === 'perfect') {
          setStatus('verified-exact');
        } else if (m) {
          setStatus('verified-match');
        } else {
          // 200 with no match field — treat as still pending.
          setStatus('pending');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800/60 px-2 py-0.5 text-[11px] text-zinc-400">
        Checking Sourcify…
      </span>
    );
  }

  if (status === 'verified-exact' || status === 'verified-match') {
    const label = status === 'verified-exact' ? 'Sourcify verified ✓ exact' : 'Sourcify verified ✓';
    return (
      <a
        href={`${SOURCIFY_REPO}/${CHAIN_ID}/${token}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/30"
        title="Source verified on Sourcify — open the repository entry"
      >
        {label} ↗
      </a>
    );
  }

  if (status === 'pending') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300"
        title="The auto-Sourcify cron submits new tokens within ~10 minutes of launch."
      >
        Pending Sourcify verification
      </span>
    );
  }

  if (status === 'unsupported') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-zinc-700/40 px-2 py-0.5 text-[11px] text-zinc-300"
        title="Etica mainnet (61803) is not yet supported by the public Sourcify server. See docs/SOURCIFY_CHAIN_SUBMISSION.md."
      >
        Chain pending Sourcify support
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-700/40 px-2 py-0.5 text-[11px] text-zinc-400">
      Sourcify status unavailable
    </span>
  );
}
