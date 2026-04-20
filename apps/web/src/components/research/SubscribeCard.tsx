'use client';

import { useEffect, useMemo, useState } from 'react';
import { BaseError, UserRejectedRequestError } from 'viem';
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { abis, DEPLOYMENTS, EXTERNAL_ADDRESSES, isSupportedChainId } from '@etica-hub/shared';

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const MONTHS = [1, 3, 6, 12] as const;

function describe(err: unknown, fallback: string): string | undefined {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return undefined;
    return err.shortMessage || err.message || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

function formatExpiry(ts: bigint | undefined): string {
  if (!ts || ts === 0n) return '—';
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

export function SubscribeCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [months, setMonths] = useState<number>(1);
  const [error, setError] = useState<string | undefined>();

  const sub = isSupportedChainId(chainId) ? DEPLOYMENTS[chainId].researchSubscription : undefined;
  const eti = isSupportedChainId(chainId) ? EXTERNAL_ADDRESSES[chainId].eti : undefined;
  const contractDeployed = Boolean(sub && sub !== ZERO);

  const priceCall = useReadContract({
    abi: abis.researchSubscriptionAbi,
    address: sub,
    functionName: 'pricePerMonth',
    query: { enabled: contractDeployed },
  });
  const expiryCall = useReadContract({
    abi: abis.researchSubscriptionAbi,
    address: sub,
    functionName: 'expiresAt',
    args: address ? [address] : undefined,
    query: { enabled: contractDeployed && Boolean(address) },
  });
  const allowanceCall = useReadContract({
    abi: abis.erc20Abi,
    address: eti,
    functionName: 'allowance',
    args: address && sub ? [address, sub] : undefined,
    query: { enabled: contractDeployed && Boolean(address && eti) },
  });
  const balanceCall = useReadContract({
    abi: abis.erc20Abi,
    address: eti,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: contractDeployed && Boolean(address && eti) },
  });

  const price = (priceCall.data as bigint | undefined) ?? 0n;
  const expiry = (expiryCall.data as bigint | undefined) ?? 0n;
  const allowance = (allowanceCall.data as bigint | undefined) ?? 0n;
  const balance = (balanceCall.data as bigint | undefined) ?? 0n;

  const total = useMemo(() => price * BigInt(months), [price, months]);
  const needsApproval = contractDeployed && total > 0n && allowance < total;
  const insufficient = contractDeployed && total > 0n && balance < total;
  const isActive = expiry > BigInt(Math.floor(Date.now() / 1000));

  // Split approve/subscribe state so the approve "Confirmed" badge can't leak
  // into the subscribe button and mislead the user about their status.
  const approveWrite = useWriteContract();
  const subscribeWrite = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveWrite.data,
    query: { enabled: Boolean(approveWrite.data) },
  });
  const subscribeReceipt = useWaitForTransactionReceipt({
    hash: subscribeWrite.data,
    query: { enabled: Boolean(subscribeWrite.data) },
  });

  // Refetch allowance immediately after approve confirms so `needsApproval`
  // flips to false on the next render — the button label + handler then
  // advance to "Subscribe" instead of misrepresenting progress.
  useEffect(() => {
    if (approveReceipt.isSuccess) {
      allowanceCall.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt.isSuccess]);

  // Refetch expiry + balance + allowance after subscribe confirms so the
  // "Active until …" line reflects the new expiry rather than the stale pre-tx
  // value (which shows `—` for first-time subscribers).
  useEffect(() => {
    if (subscribeReceipt.isSuccess) {
      expiryCall.refetch();
      balanceCall.refetch();
      allowanceCall.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeReceipt.isSuccess]);

  async function onApprove() {
    if (!sub || !eti) return;
    setError(undefined);
    try {
      await approveWrite.writeContractAsync({
        abi: abis.erc20Abi,
        address: eti,
        functionName: 'approve',
        args: [sub, MAX_UINT256],
      });
    } catch (e) {
      setError(describe(e, 'Approval failed'));
    }
  }

  async function onSubscribe() {
    if (!sub) return;
    setError(undefined);
    try {
      await subscribeWrite.writeContractAsync({
        abi: abis.researchSubscriptionAbi,
        address: sub,
        functionName: 'subscribe',
        args: [BigInt(months)],
      });
    } catch (e) {
      setError(describe(e, 'Subscribe failed'));
    }
  }

  if (!contractDeployed) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-sm">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/60">
          Subscribe
        </h3>
        <p className="text-xs text-white/50">
          Research subscriptions become active once the <code>ResearchSubscription</code> contract
          is deployed on this chain.
        </p>
      </div>
    );
  }

  const approvePending =
    Boolean(approveWrite.data) && !approveReceipt.isSuccess && !approveReceipt.isError;
  const subscribePending =
    Boolean(subscribeWrite.data) && !subscribeReceipt.isSuccess && !subscribeReceipt.isError;
  const busy =
    approveWrite.isPending ||
    subscribeWrite.isPending ||
    approveReceipt.isFetching ||
    subscribeReceipt.isFetching;

  // After a successful subscribe, celebrate; otherwise advance through the
  // two-step flow using the fresh allowance read from the receipt-triggered
  // refetch.
  const subscribeConfirmed = subscribeReceipt.isSuccess;
  const disabled = !isConnected || insufficient || busy;

  function buttonLabel(): string {
    if (!isConnected) return 'Connect wallet';
    if (insufficient) return 'Insufficient ETI';
    if (subscribeConfirmed) return isActive ? 'Extend again' : 'Subscribed';
    if (subscribePending) return 'Subscribing…';
    if (approvePending) return 'Approving…';
    if (needsApproval) return 'Approve ETI';
    if (isActive) return 'Extend';
    return 'Subscribe';
  }

  function onClick() {
    if (needsApproval) void onApprove();
    else void onSubscribe();
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/60">
        Subscribe
      </h3>
      <p className="mb-3 text-xs text-white/50">
        {isActive
          ? `Active until ${formatExpiry(expiry)}. Extend your access below.`
          : 'Pay monthly ETI for curated feeds and ETI-gated content.'}
      </p>

      <div className="mb-3 flex gap-1">
        {MONTHS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMonths(m)}
            className={`flex-1 rounded-lg border px-2 py-1 text-xs transition ${
              months === m
                ? 'border-white/30 bg-white/10 text-white'
                : 'border-white/10 text-white/60 hover:border-white/20 hover:text-white'
            }`}
          >
            {m}mo
          </button>
        ))}
      </div>

      <dl className="mb-3 space-y-1 text-xs text-white/60">
        <div className="flex justify-between">
          <dt>Price / month</dt>
          <dd>{(Number(price) / 1e18).toFixed(4)} ETI</dd>
        </div>
        <div className="flex justify-between">
          <dt>Total</dt>
          <dd className="text-white">{(Number(total) / 1e18).toFixed(4)} ETI</dd>
        </div>
        <div className="flex justify-between">
          <dt>Your balance</dt>
          <dd>{(Number(balance) / 1e18).toFixed(4)} ETI</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="w-full rounded-lg bg-white py-2 text-sm font-medium text-black transition enabled:hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
      >
        {buttonLabel()}
      </button>

      {error && (
        <p className="mt-2 rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-200">{error}</p>
      )}
      {approveReceipt.isSuccess && !subscribePending && !subscribeConfirmed && !needsApproval && (
        <p className="mt-2 text-[11px] text-white/60">
          Approved. Tap &ldquo;Subscribe&rdquo; to complete.
        </p>
      )}
      {subscribeConfirmed && (
        <p className="mt-2 text-[11px] text-emerald-300/80">Active until {formatExpiry(expiry)}</p>
      )}
    </div>
  );
}
