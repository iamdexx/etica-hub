/**
 * Buy/sell card for a single research-token market. Runs against the
 * EticaResearchMarkets singleton's bonding curve:
 *   - Buy: user spends ETX (gross), curve mints `tokensOut` to user.
 *   - Sell: user surrenders tokens (burned by curve), receives ETX.
 *
 * Quotes are read from `quoteBuy / quoteSell` views with debounced
 * refetch on input change. Slippage is applied client-side via
 * `minTokensOut / minEtxOut` floor params; deadline defaults to 20m.
 *
 * Approvals: buying ETX requires ERC20 approval to the singleton; selling
 * the research token also requires the user to approve the singleton on
 * the token (the singleton calls `transferFrom + burnFromMarket`).
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  formatUnits,
  parseUnits,
  type Address,
} from 'viem';
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { eticaMainnet } from '@etica-hub/shared/chains';
import { DEPLOYMENTS, abis, isSupportedChainId } from '@etica-hub/shared';
import { useResearchMarketsAddress, type ResearchMarket } from '@/lib/research-markets';

const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_SLIPPAGE_BPS = 100n; // 1.00%
const DEFAULT_DEADLINE_MIN = 20;

type Side = 'buy' | 'sell';

export function BuySellCard({ market }: { market: ResearchMarket }) {
  const { address: connected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const singleton = useResearchMarketsAddress();

  const etx = useMemo<Address | null>(() => {
    if (!isSupportedChainId(chainId)) return null;
    const a = DEPLOYMENTS[chainId].etx;
    return a === '0x0000000000000000000000000000000000000000' ? null : a;
  }, [chainId]);

  const [side, setSide] = useState<Side>('buy');
  const [amountStr, setAmountStr] = useState('');
  const [slippageBps, setSlippageBps] = useState<bigint>(DEFAULT_SLIPPAGE_BPS);
  const [deadlineMin, setDeadlineMin] = useState<number>(DEFAULT_DEADLINE_MIN);
  const [error, setError] = useState<string | null>(null);

  const amount = useMemo(() => {
    try {
      const t = amountStr.trim();
      if (!t) return 0n;
      return parseUnits(t, 18);
    } catch {
      return 0n;
    }
  }, [amountStr]);

  // ─── Quotes ───
  const { data: buyQuote } = useReadContract({
    address: singleton ?? undefined,
    abi: abis.eticaResearchMarketsAbi,
    functionName: 'quoteBuy',
    args: side === 'buy' && amount > 0n ? [market.token, amount] : undefined,
    query: { enabled: side === 'buy' && amount > 0n && !!singleton, refetchInterval: 10_000 },
  });

  const { data: sellQuote } = useReadContract({
    address: singleton ?? undefined,
    abi: abis.eticaResearchMarketsAbi,
    functionName: 'quoteSell',
    args: side === 'sell' && amount > 0n ? [market.token, amount] : undefined,
    query: { enabled: side === 'sell' && amount > 0n && !!singleton, refetchInterval: 10_000 },
  });

  // ─── Balances ───
  const { data: etxBal } = useBalance({
    address: connected,
    token: etx ?? undefined,
    query: { enabled: !!connected && !!etx, refetchInterval: 15_000 },
  });
  const { data: tokenBal } = useBalance({
    address: connected,
    token: market.token,
    query: { enabled: !!connected, refetchInterval: 15_000 },
  });

  // ─── Allowances ───
  const { data: etxAllowance } = useReadContract({
    address: etx ?? undefined,
    abi: abis.erc20Abi,
    functionName: 'allowance',
    args: connected && singleton ? [connected, singleton] : undefined,
    query: { enabled: !!connected && !!singleton && !!etx, refetchInterval: 10_000 },
  });
  const { data: tokenAllowance } = useReadContract({
    address: market.token,
    abi: abis.erc20Abi,
    functionName: 'allowance',
    args: connected && singleton ? [connected, singleton] : undefined,
    query: { enabled: !!connected && !!singleton, refetchInterval: 10_000 },
  });

  // ─── Writes ───
  const { writeContractAsync, data: txHash, reset: resetWrite } = useWriteContract();
  const { isLoading: confirming, isSuccess: confirmed } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (confirmed) {
      setAmountStr('');
    }
  }, [confirmed]);

  // ─── Derived ───
  const tokensOut = (buyQuote as readonly [bigint, bigint] | undefined)?.[0] ?? 0n;
  const buyFee = (buyQuote as readonly [bigint, bigint] | undefined)?.[1] ?? 0n;
  const etxOut = (sellQuote as readonly [bigint, bigint] | undefined)?.[0] ?? 0n;
  const sellFee = (sellQuote as readonly [bigint, bigint] | undefined)?.[1] ?? 0n;

  const minTokensOut = side === 'buy' && tokensOut > 0n
    ? (tokensOut * (10000n - slippageBps)) / 10000n
    : 0n;
  const minEtxOut = side === 'sell' && etxOut > 0n
    ? (etxOut * (10000n - slippageBps)) / 10000n
    : 0n;

  const needsEtxApproval = side === 'buy' && amount > 0n
    && (etxAllowance as bigint | undefined ?? 0n) < amount;
  const needsTokenApproval = side === 'sell' && amount > 0n
    && (tokenAllowance as bigint | undefined ?? 0n) < amount;

  const insufficientBalance = side === 'buy'
    ? amount > (etxBal?.value ?? 0n)
    : amount > (tokenBal?.value ?? 0n);

  const onChainGate = !connected
    ? 'Connect wallet'
    : !isSupportedChainId(chainId) || chainId !== eticaMainnet.id
      ? 'Switch chain'
      : !singleton
        ? 'Not deployed'
        : null;

  // ─── Handlers ───
  async function handleSwitch() {
    await switchChainAsync({ chainId: eticaMainnet.id });
  }

  async function handleApprove() {
    if (!singleton) return;
    setError(null);
    try {
      await writeContractAsync({
        address: side === 'buy' ? (etx as Address) : market.token,
        abi: abis.erc20Abi,
        functionName: 'approve',
        args: [singleton, MAX_UINT256],
      });
    } catch (err) {
      const message = err instanceof BaseError ? err.shortMessage : String(err);
      setError(`Approval failed: ${message}`);
    }
  }

  async function handleTrade() {
    if (!singleton || amount === 0n) return;
    setError(null);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);
    try {
      if (side === 'buy') {
        await writeContractAsync({
          address: singleton,
          abi: abis.eticaResearchMarketsAbi,
          functionName: 'buy',
          args: [market.token, amount, minTokensOut, deadline],
        });
      } else {
        await writeContractAsync({
          address: singleton,
          abi: abis.eticaResearchMarketsAbi,
          functionName: 'sell',
          args: [market.token, amount, minEtxOut, deadline],
        });
      }
    } catch (err) {
      const message = err instanceof BaseError ? err.shortMessage : String(err);
      setError(`${side === 'buy' ? 'Buy' : 'Sell'} failed: ${message}`);
    }
  }

  function setMax() {
    if (side === 'buy' && etxBal) {
      setAmountStr(formatUnits(etxBal.value, 18));
    } else if (side === 'sell' && tokenBal) {
      setAmountStr(formatUnits(tokenBal.value, 18));
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      {/* Side toggle */}
      <div className="flex rounded-lg border border-zinc-800 bg-zinc-950/50 p-1">
        <button
          type="button"
          onClick={() => {
            setSide('buy');
            setAmountStr('');
            resetWrite();
          }}
          className={`flex-1 rounded-md py-1.5 text-sm font-semibold transition ${
            side === 'buy' ? 'bg-emerald-600/30 text-emerald-200' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => {
            setSide('sell');
            setAmountStr('');
            resetWrite();
          }}
          className={`flex-1 rounded-md py-1.5 text-sm font-semibold transition ${
            side === 'sell' ? 'bg-rose-600/30 text-rose-200' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Sell
        </button>
      </div>

      {/* Amount input */}
      <div>
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>{side === 'buy' ? 'You pay (ETX)' : `You sell (${market.symbol || 'TOKEN'})`}</span>
          <button
            type="button"
            onClick={setMax}
            disabled={!connected}
            className="text-[10px] uppercase text-sky-400 hover:text-sky-300 disabled:opacity-50"
          >
            Max
          </button>
        </div>
        <input
          type="text"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0.0"
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950/60 px-3 py-2 font-mono text-lg text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
          <span>
            Balance:{' '}
            {side === 'buy'
              ? etxBal
                ? `${Number(formatUnits(etxBal.value, 18)).toFixed(4)} ETX`
                : '—'
              : tokenBal
                ? `${Number(formatUnits(tokenBal.value, 18)).toFixed(4)} ${market.symbol || ''}`
                : '—'}
          </span>
          {insufficientBalance && amount > 0n && (
            <span className="text-amber-400">Insufficient balance</span>
          )}
        </div>
      </div>

      {/* Quote readout */}
      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
        <div className="flex items-center justify-between text-zinc-400">
          <span>{side === 'buy' ? 'You receive' : 'You receive (net)'}</span>
          <span className="font-mono text-sm text-zinc-100">
            {side === 'buy'
              ? `${Number(formatUnits(tokensOut, 18)).toFixed(6)} ${market.symbol || 'TOKEN'}`
              : `${Number(formatUnits(etxOut, 18)).toFixed(6)} ETX`}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-zinc-500">
          <span>Fee (1%)</span>
          <span className="font-mono">
            {Number(formatUnits(side === 'buy' ? buyFee : sellFee, 18)).toFixed(6)} ETX
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-zinc-500">
          <span>Min received ({Number(slippageBps) / 100}% slippage)</span>
          <span className="font-mono">
            {side === 'buy'
              ? `${Number(formatUnits(minTokensOut, 18)).toFixed(6)} ${market.symbol || 'TOKEN'}`
              : `${Number(formatUnits(minEtxOut, 18)).toFixed(6)} ETX`}
          </span>
        </div>
      </div>

      {/* Slippage + deadline */}
      <details className="text-xs">
        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">Settings</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">Slippage (bps)</span>
            <input
              type="number"
              value={Number(slippageBps)}
              min={1}
              max={1000}
              onChange={(e) => setSlippageBps(BigInt(Math.max(1, Math.min(1000, Number(e.target.value) || 0))))}
              className="rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 font-mono text-xs text-zinc-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">Deadline (min)</span>
            <input
              type="number"
              value={deadlineMin}
              min={1}
              max={1440}
              onChange={(e) => setDeadlineMin(Math.max(1, Math.min(1440, Number(e.target.value) || DEFAULT_DEADLINE_MIN)))}
              className="rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 font-mono text-xs text-zinc-100"
            />
          </label>
        </div>
      </details>

      {error && (
        <p className="break-all rounded border border-red-700/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* Status hint */}
      {market.status === 'sunset' && side === 'buy' && (
        <p className="rounded border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          This market is sunsetted. Buying it will re-activate the market, but it has been dormant.
        </p>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {onChainGate === 'Connect wallet' ? (
          <button
            type="button"
            disabled
            className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-2 text-sm font-semibold text-zinc-400"
          >
            Connect wallet
          </button>
        ) : onChainGate === 'Switch chain' ? (
          <button
            type="button"
            onClick={handleSwitch}
            disabled={switching}
            className="rounded-lg border border-amber-600 bg-amber-600/20 px-4 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-600/30"
          >
            {switching ? 'Switching…' : 'Switch to Etica mainnet'}
          </button>
        ) : (needsEtxApproval || needsTokenApproval) ? (
          <button
            type="button"
            onClick={handleApprove}
            disabled={confirming || amount === 0n}
            className="rounded-lg border border-sky-600 bg-sky-600/20 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-600/30 disabled:opacity-50"
          >
            {confirming ? 'Approving…' : `Approve ${side === 'buy' ? 'ETX' : market.symbol || 'token'}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleTrade}
            disabled={
              !singleton ||
              amount === 0n ||
              insufficientBalance ||
              confirming
            }
            className={`rounded-lg border px-4 py-2 text-sm font-semibold transition ${
              side === 'buy'
                ? 'border-emerald-600 bg-emerald-600/20 text-emerald-200 hover:bg-emerald-600/30'
                : 'border-rose-600 bg-rose-600/20 text-rose-200 hover:bg-rose-600/30'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {confirming ? 'Confirming…' : side === 'buy' ? `Buy ${market.symbol || 'token'}` : `Sell ${market.symbol || 'token'}`}
          </button>
        )}
      </div>
    </div>
  );
}
