/**
 * Wallet-gated flag / vouch controls for an EticaLabs goal or job.
 *
 * Voter must connect a wallet on chain 61803 and hold ≥ 100 ETX.
 * Weight = balance, soft-capped at 100k ETX per wallet.
 * Each vote is EIP-191 signed; the server re-verifies and records the
 * raw signature into the public moderation log.
 */
'use client';

import { useCallback, useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';

import { signVote } from '@/lib/labs/client-sig';
import { FLAG_REASONS, type FlagReason } from '@/lib/labs/moderation';

interface FlagVouchPanelProps {
  targetType: 'goal' | 'job';
  targetId: string;
  /** Optional callback after a successful vote so the parent can refetch. */
  onVoted?: () => void;
}

export function FlagVouchPanel({ targetType, targetId, onVoted }: FlagVouchPanelProps): JSX.Element {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [reason, setReason] = useState<FlagReason>('off-topic');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState<'flag' | 'vouch' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useCallback(
    async (action: 'flag' | 'vouch') => {
      if (!isConnected || !address || !walletClient) {
        setError('Connect a wallet on chain 61803 holding ≥ 100 ETX to vote.');
        return;
      }
      setBusy(action);
      setError(null);
      setNotice(null);
      try {
        const sig = await signVote({
          action,
          targetType,
          targetId,
          reason: action === 'flag' ? reason : undefined,
          wallet: address,
          walletClient,
        });
        const res = await fetch('/api/labs/moderation/vote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            targetType,
            targetId,
            wallet: sig.wallet,
            signature: sig.signature,
            issuedAt: sig.issuedAt,
            ...(action === 'flag' ? { reason, detail: detail.trim() || undefined } : {}),
          }),
        });
        const data = (await res.json()) as { error?: string; newStatus?: string };
        if (!res.ok) {
          throw new Error(data.error ?? `vote failed (${res.status})`);
        }
        setNotice(
          action === 'flag'
            ? `Flag recorded${data.newStatus ? ` (status: ${data.newStatus})` : ''}.`
            : `Vouch recorded${data.newStatus ? ` (status: ${data.newStatus})` : ''}.`,
        );
        onVoted?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Vote failed.');
      } finally {
        setBusy(null);
      }
    },
    [isConnected, address, walletClient, targetType, targetId, reason, detail, onVoted],
  );

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-sm font-medium text-white">Community moderation</p>
      <p className="mt-1 text-xs text-white/55">
        Flag or vouch with your wallet. Weight = ETX balance (≥ 100 minimum, soft-capped at
        100k). All votes are signed and publicly logged.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-white/55">
          Flag reason
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as FlagReason)}
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-white outline-none focus:border-white/30"
          >
            {FLAG_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-white/55">
          Detail (optional)
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={140}
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-white outline-none focus:border-white/30"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => submit('flag')}
          disabled={busy !== null}
          className="rounded-full border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
        >
          {busy === 'flag' ? 'Signing…' : 'Flag'}
        </button>
        <button
          type="button"
          onClick={() => submit('vouch')}
          disabled={busy !== null}
          className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {busy === 'vouch' ? 'Signing…' : 'Vouch'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-300">{notice}</p>}
    </div>
  );
}
