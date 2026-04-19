'use client';

import { useMemo, useState } from 'react';
import { BaseError, UserRejectedRequestError, parseUnits, type Address } from 'viem';
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { abis, EXTERNAL_ADDRESSES, isSupportedChainId } from '@etica-hub/shared';

const QUICK_AMOUNTS = ['1', '5', '10', '50'] as const;

function describe(err: unknown, fallback: string): string | undefined {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return undefined;
    return err.shortMessage || err.message || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export function TipWidget({ recipient, title }: { recipient: Address; title: string }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [amountStr, setAmountStr] = useState('1');
  const [error, setError] = useState<string | undefined>();

  const eti = isSupportedChainId(chainId) ? EXTERNAL_ADDRESSES[chainId].eti : undefined;

  const balance = useReadContract({
    abi: abis.erc20Abi,
    address: eti,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && eti) },
  });

  const amount = useMemo(() => {
    try {
      return parseUnits(amountStr || '0', 18);
    } catch {
      return 0n;
    }
  }, [amountStr]);

  const { writeContractAsync, data: hash, reset, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash, query: { enabled: Boolean(hash) } });

  const isSelfTip = address && recipient.toLowerCase() === address.toLowerCase();
  const insufficient = typeof balance.data === 'bigint' && amount > 0n && amount > balance.data;

  const disabled =
    !isConnected ||
    !eti ||
    amount === 0n ||
    insufficient ||
    Boolean(isSelfTip) ||
    isPending ||
    receipt.isFetching;

  async function onTip() {
    if (!eti || amount === 0n) return;
    setError(undefined);
    reset();
    try {
      await writeContractAsync({
        abi: abis.erc20Abi,
        address: eti,
        functionName: 'transfer',
        args: [recipient, amount],
      });
    } catch (e) {
      setError(describe(e, 'Tip failed'));
    }
  }

  const confirmed = receipt.isSuccess;
  const pending = Boolean(hash) && !receipt.isSuccess;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/60">
        Tip the researcher
      </h3>
      <p className="mb-3 text-xs text-white/50">
        Send ETI directly to the proposer of “{title || 'this proposal'}”.
      </p>

      <div className="mb-2 flex gap-1">
        {QUICK_AMOUNTS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setAmountStr(v)}
            className={`flex-1 rounded-lg border px-2 py-1 text-xs transition ${
              amountStr === v
                ? 'border-white/30 bg-white/10 text-white'
                : 'border-white/10 text-white/60 hover:border-white/20 hover:text-white'
            }`}
          >
            {v} ETI
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
        <input
          inputMode="decimal"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ''))}
          className="w-full bg-transparent text-base text-white outline-none placeholder:text-white/30"
          placeholder="0.0"
        />
        <span className="text-xs text-white/50">ETI</span>
      </label>

      {isConnected && typeof balance.data === 'bigint' && (
        <p className="mt-1 text-[11px] text-white/40">
          Your ETI: {(Number(balance.data) / 1e18).toFixed(4)}
        </p>
      )}

      <button
        type="button"
        onClick={onTip}
        disabled={disabled}
        className="mt-3 w-full rounded-lg bg-white py-2 text-sm font-medium text-black transition enabled:hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
      >
        {!isConnected
          ? 'Connect wallet to tip'
          : isSelfTip
            ? "You can't tip yourself"
            : insufficient
              ? 'Insufficient ETI'
              : amount === 0n
                ? 'Enter an amount'
                : pending
                  ? 'Sending…'
                  : confirmed
                    ? 'Sent ·  tap to tip again'
                    : 'Send tip'}
      </button>

      {error && (
        <p className="mt-2 rounded-md bg-rose-500/10 px-2 py-1 text-xs text-rose-200">{error}</p>
      )}
      {confirmed && hash && (
        <p className="mt-2 break-all text-[11px] text-emerald-300/80">Confirmed · tx {hash}</p>
      )}
    </div>
  );
}
