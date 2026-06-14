/**
 * "Branch from this" — spawn a child research goal from an existing
 * discovery (a completed candidate or a minted RES you hold). The child
 * goal is created with `parentGoalId`/`parentJobId` set, which is what
 * forms the on-chain ancestor-cascade link (`parentBranchGoalId`) when
 * the child is later minted: every future sale of the descendant then
 * cascades royalties up to this ancestor.
 *
 * Wallet signs a `submit-job` message bound to
 *   `branch:${parentJobId}#${candidateIndex}|${prompt}`
 * (no gas) and the server creates + enqueues the branch goal.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, useWalletClient } from 'wagmi';

import { signSubmit } from '@/lib/labs/client-sig';

const MAX_PROMPT_CHARS = 400;

/**
 * Two source modes:
 *   - candidate: branch from a live queue job (parentJobId + candidateIndex)
 *   - token:     branch from a minted RES NFT (tokenId), TTL-free, via
 *                /api/labs/goals/branch-from-token
 * Exactly one mode is used: pass `tokenId` for the token variant, else the
 * candidate fields.
 */
export function BranchFromButton({
  parentJobId,
  candidateIndex,
  tokenId,
  defaultPrompt = '',
  label = 'Branch from this',
  compact = false,
}: {
  parentJobId?: string;
  candidateIndex?: number;
  tokenId?: string | number;
  defaultPrompt?: string;
  label?: string;
  compact?: boolean;
}): JSX.Element {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleBranch(): Promise<void> {
    setError(null);
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError('Describe what to explore on this lead.');
      return;
    }
    if (!isConnected || !address || !walletClient) {
      setError('Connect your wallet to start a branch.');
      return;
    }
    const isToken = tokenId !== undefined && tokenId !== null && `${tokenId}` !== '';
    if (!isToken && (!parentJobId || candidateIndex === undefined)) {
      setError('Nothing to branch from.');
      return;
    }
    setBusy(true);
    try {
      const signedPayload = isToken
        ? `branch-token:${tokenId}|${trimmed}`
        : `branch:${parentJobId}#${candidateIndex}|${trimmed}`;
      const sig = await signSubmit({
        action: 'submit-job',
        payload: signedPayload,
        wallet: address,
        walletClient,
      });
      const url = isToken
        ? '/api/labs/goals/branch-from-token'
        : '/api/labs/goals/branch-from-candidate';
      const payload = isToken
        ? {
            tokenId: `${tokenId}`,
            prompt: trimmed,
            wallet: sig.wallet,
            signature: sig.signature,
            issuedAt: sig.issuedAt,
          }
        : {
            parentJobId,
            candidateIndex,
            prompt: trimmed,
            wallet: sig.wallet,
            signature: sig.signature,
            issuedAt: sig.issuedAt,
          };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        jobId?: string;
        goalId?: string;
        error?: string;
      };
      if (!res.ok || !body.jobId) {
        setError(body.error ?? `Branch failed (${res.status}).`);
        return;
      }
      router.push(`/labs/feed/${body.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Branch failed.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          compact
            ? 'rounded border border-fuchsia-300/40 bg-fuchsia-400/10 px-2.5 py-1 text-[11px] uppercase tracking-wider text-fuchsia-100 transition-colors hover:border-fuchsia-200/60 hover:bg-fuchsia-400/20'
            : 'rounded border border-fuchsia-300/40 bg-fuchsia-400/10 px-3 py-1.5 text-xs uppercase tracking-wider text-fuchsia-100 transition-colors hover:border-fuchsia-200/60 hover:bg-fuchsia-400/20'
        }
      >
        {label}
      </button>
    );
  }

  return (
    <div className="mt-2 w-full rounded-lg border border-fuchsia-300/20 bg-fuchsia-400/[0.04] p-3">
      <label className="mb-1 block text-[11px] uppercase tracking-wider text-fuchsia-200/80">
        Branch direction
      </label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_CHARS))}
        rows={2}
        placeholder="e.g. improve binding affinity to the target while preserving stability"
        className="w-full resize-none rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white/90 placeholder:text-white/30 focus:border-fuchsia-300/50 focus:outline-none"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[10px] text-white/35">
          {prompt.length}/{MAX_PROMPT_CHARS}
        </span>
        {!isConnected && (
          <span className="text-[10px] text-amber-200/80">connect wallet to branch</span>
        )}
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !isConnected}
          onClick={() => {
            void handleBranch();
          }}
          className="rounded border border-fuchsia-300/40 bg-fuchsia-400/15 px-3 py-1 text-[11px] uppercase tracking-wider text-fuchsia-100 transition-colors hover:bg-fuchsia-400/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'branching…' : 'start branch'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded border border-white/10 px-3 py-1 text-[11px] uppercase tracking-wider text-white/60 transition-colors hover:bg-white/5 disabled:opacity-60"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
