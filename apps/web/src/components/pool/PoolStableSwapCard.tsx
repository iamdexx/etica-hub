'use client';

/**
 * Public-LP add/remove for the rate-aware stETX/ETX stableswap pool.
 *
 * Lives below the V2 add-liquidity card on /pool. Public LPs use the same
 * `EticaStableSwap.addLiquidity` / `removeLiquidity` entrypoints as anyone
 * else — there is no separate "treasury vs public" path inside the pool;
 * the 10-year lock only applies to the treasury seed via the standalone
 * `LiquidityTimelock10y` holder. Public LP shares stay in the user's
 * wallet and are withdrawable any time.
 *
 * Add: balanced or unbalanced. We quote LP shares via `calcAddLiquidity`
 * and apply a 0.50% slippage floor on `minMintAmount` so the tx still
 * lands if NAV drifts a hair between the quote and the inclusion block.
 *
 * Remove: pro-rata (`removeLiquidity`). Slippage-free by construction —
 * the math is straight ratio of reserves, no curve invariant — so we
 * pin `minEtx` / `minStEtx` to (quote × (1 - slippage)) just to defend
 * against NAV drift between read and tx.
 *
 * On chains where the pool isn't deployed yet (`eticaStableSwap == 0x0`)
 * we render nothing so the rest of /pool stays usable. When the pair
 * fee tier hasn't been seeded yet (`totalSupply == 0`) we hide entirely
 * — the deployer is responsible for the initial deposit, not random
 * users (the contract enforces NAV-balanced first deposit).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  DEPLOYMENTS,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
/** 0.50% slippage floor on add/remove. Generous given stableswap math. */
const DEFAULT_SLIPPAGE_BPS = 50n;

type Mode = 'add' | 'remove';

type Ctx = {
  chainId: number;
  pool: Address;
  etx: Address;
  stetx: Address;
};

function useCtx(): Ctx | null {
  const chainId = useChainId();
  return useMemo(() => {
    if (!isSupportedChainId(chainId)) return null;
    const d = DEPLOYMENTS[chainId];
    if (
      d.eticaStableSwap === ZERO ||
      d.etx === ZERO ||
      d.stakedETX === ZERO
    ) {
      return null;
    }
    return {
      chainId,
      pool: d.eticaStableSwap,
      etx: d.etx,
      stetx: d.stakedETX,
    };
  }, [chainId]);
}

function describeWriteError(err: unknown, fallback: string): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function fmt(n: bigint, maxFrac = 4): string {
  const s = formatUnits(n, 18);
  const [int, frac = ''] = s.split('.');
  if (!frac) return int;
  return `${int}.${frac.slice(0, maxFrac)}`;
}

export function PoolStableSwapCard() {
  const { address, isConnected } = useAccount();
  const ctx = useCtx();

  const [mode, setMode] = useState<Mode>('add');
  const [etxStr, setEtxStr] = useState('');
  const [stEtxStr, setStEtxStr] = useState('');
  const [lpStr, setLpStr] = useState('');
  const [submitError, setSubmitError] = useState<string | undefined>();

  // Pool state. We need: reserves (display), totalSupply (gate the card on
  // initial-deposit-not-yet), live rate (informational, "1 stETX = X ETX"),
  // user balances (max buttons + "you have"), user allowances (approval
  // gating), user LP balance (remove-side cap).
  const reads = useReadContracts({
    allowFailure: false,
    contracts:
      ctx && address
        ? [
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'reserveEtx' as const,
            },
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'reserveStEtx' as const,
            },
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'totalSupply' as const,
            },
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'getRate' as const,
            },
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'balanceOf' as const,
              args: [address],
            },
            {
              abi: abis.erc20Abi,
              address: ctx.etx,
              functionName: 'balanceOf' as const,
              args: [address],
            },
            {
              abi: abis.erc20Abi,
              address: ctx.stetx,
              functionName: 'balanceOf' as const,
              args: [address],
            },
            {
              abi: abis.erc20Abi,
              address: ctx.etx,
              functionName: 'allowance' as const,
              args: [address, ctx.pool],
            },
            {
              abi: abis.erc20Abi,
              address: ctx.stetx,
              functionName: 'allowance' as const,
              args: [address, ctx.pool],
            },
          ]
        : ctx
        ? [
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'reserveEtx' as const,
            },
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'reserveStEtx' as const,
            },
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'totalSupply' as const,
            },
            {
              abi: abis.eticaStableSwapAbi,
              address: ctx.pool,
              functionName: 'getRate' as const,
            },
          ]
        : [],
    query: { enabled: Boolean(ctx) },
  });

  const reserveEtx = (reads.data?.[0] as bigint | undefined) ?? 0n;
  const reserveStEtx = (reads.data?.[1] as bigint | undefined) ?? 0n;
  const totalSupply = (reads.data?.[2] as bigint | undefined) ?? 0n;
  const rate = (reads.data?.[3] as bigint | undefined) ?? 0n;
  const lpBalance = address
    ? ((reads.data?.[4] as bigint | undefined) ?? 0n)
    : 0n;
  const etxBal = address
    ? ((reads.data?.[5] as bigint | undefined) ?? 0n)
    : 0n;
  const stEtxBal = address
    ? ((reads.data?.[6] as bigint | undefined) ?? 0n)
    : 0n;
  const etxAllowance = address
    ? ((reads.data?.[7] as bigint | undefined) ?? 0n)
    : 0n;
  const stEtxAllowance = address
    ? ((reads.data?.[8] as bigint | undefined) ?? 0n)
    : 0n;

  const amountEtx = useMemo(() => {
    if (!etxStr) return 0n;
    try {
      return parseUnits(etxStr, 18);
    } catch {
      return 0n;
    }
  }, [etxStr]);
  const amountStEtx = useMemo(() => {
    if (!stEtxStr) return 0n;
    try {
      return parseUnits(stEtxStr, 18);
    } catch {
      return 0n;
    }
  }, [stEtxStr]);
  const amountLp = useMemo(() => {
    if (!lpStr) return 0n;
    try {
      return parseUnits(lpStr, 18);
    } catch {
      return 0n;
    }
  }, [lpStr]);

  // Add-side LP estimate. Pure view, no state writes. Skipped while
  // totalSupply == 0 (the contract rejects unbalanced first deposits, and
  // we don't want public LPs to seed anyway — that path is /deploy).
  const addQuote = useReadContract({
    abi: abis.eticaStableSwapAbi,
    address: ctx?.pool,
    functionName: 'calcAddLiquidity',
    args:
      mode === 'add' && (amountEtx > 0n || amountStEtx > 0n)
        ? [amountEtx, amountStEtx]
        : undefined,
    query: {
      enabled: Boolean(
        ctx &&
          mode === 'add' &&
          totalSupply > 0n &&
          (amountEtx > 0n || amountStEtx > 0n),
      ),
    },
  });
  const lpEstimate = (addQuote.data as bigint | undefined) ?? 0n;

  // Remove-side estimate is just pro-rata: balance × lpAmount / totalSupply.
  // We compute locally instead of `calcRemoveLiquidity` to avoid a second
  // RPC roundtrip per keystroke; the contract math is identical.
  const removeQuote = useMemo<{ etx: bigint; stEtx: bigint } | null>(() => {
    if (mode !== 'remove') return null;
    if (amountLp === 0n || totalSupply === 0n) return null;
    return {
      etx: (reserveEtx * amountLp) / totalSupply,
      stEtx: (reserveStEtx * amountLp) / totalSupply,
    };
  }, [mode, amountLp, totalSupply, reserveEtx, reserveStEtx]);

  const minMintAmount = useMemo<bigint>(() => {
    if (lpEstimate === 0n) return 0n;
    return (lpEstimate * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  }, [lpEstimate]);

  const minRemoveOut = useMemo<{ etx: bigint; stEtx: bigint } | null>(() => {
    if (!removeQuote) return null;
    return {
      etx: (removeQuote.etx * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n,
      stEtx:
        (removeQuote.stEtx * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n,
    };
  }, [removeQuote]);

  const etxNeedsApproval =
    mode === 'add' && amountEtx > 0n && etxAllowance < amountEtx;
  const stEtxNeedsApproval =
    mode === 'add' && amountStEtx > 0n && stEtxAllowance < amountStEtx;
  const hasEnoughEtx = mode !== 'add' || etxBal >= amountEtx;
  const hasEnoughStEtx = mode !== 'add' || stEtxBal >= amountStEtx;
  const hasEnoughLp = mode !== 'remove' || lpBalance >= amountLp;

  const {
    writeContractAsync,
    data: txHash,
    isPending: isTxPending,
    reset: resetWrite,
  } = useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<Hex | undefined>();
  const activeHash = pendingTxHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({
    hash: activeHash,
    query: { enabled: Boolean(activeHash) },
  });

  // Refresh balances + reserves the moment a tx confirms.
  useEffect(() => {
    if (!receipt.isSuccess) return;
    void reads.refetch().catch(() => {
      /* best-effort */
    });
    if (mode === 'add') {
      setEtxStr('');
      setStEtxStr('');
    } else {
      setLpStr('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, activeHash]);

  async function onApprove(token: 'etx' | 'stetx') {
    if (!ctx) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: token === 'etx' ? ctx.etx : ctx.stetx,
        functionName: 'approve',
        args: [ctx.pool, MAX_UINT256],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Approval failed'));
    }
  }

  async function onAdd() {
    if (!ctx || !address) return;
    if (amountEtx === 0n && amountStEtx === 0n) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.eticaStableSwapAbi,
        address: ctx.pool,
        functionName: 'addLiquidity',
        args: [amountEtx, amountStEtx, minMintAmount, address],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Add liquidity failed'));
    }
  }

  async function onRemove() {
    if (!ctx || !address) return;
    if (amountLp === 0n) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.eticaStableSwapAbi,
        address: ctx.pool,
        functionName: 'removeLiquidity',
        args: [
          amountLp,
          minRemoveOut?.etx ?? 0n,
          minRemoveOut?.stEtx ?? 0n,
          address,
        ],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Remove liquidity failed'));
    }
  }

  // Render-gating. Hide entirely when:
  //  - chain not supported, or
  //  - pool not yet deployed on this chain, or
  //  - pool not yet seeded (totalSupply == 0). Public LPs can't seed.
  if (!ctx) return null;
  if (totalSupply === 0n) return null;

  const txStatus = receipt.isLoading
    ? 'pending'
    : receipt.isSuccess
    ? 'confirmed'
    : null;

  return (
    <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/5 via-white/[0.02] to-cyan-500/5 p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Stableswap: stETX / ETX
          </h2>
          <p className="mt-1 text-xs text-white/60">
            Rate-aware Curve-style pool. 0.04% swap fee, 50% to LPs. No lock
            on public LP shares — withdraw any time.
          </p>
        </div>
        <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
          live
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-white/[0.03] p-3 text-xs">
        <div>
          <div className="text-white/50">Pool reserves</div>
          <div className="mt-1 font-mono text-white/90">
            {fmt(reserveEtx, 2)} ETX
          </div>
          <div className="font-mono text-white/90">
            {fmt(reserveStEtx, 2)} stETX
          </div>
        </div>
        <div>
          <div className="text-white/50">Live NAV</div>
          <div className="mt-1 font-mono text-white/90">
            1 stETX = {fmt(rate, 6)} ETX
          </div>
          <div className="text-white/50">Total LP supply</div>
          <div className="font-mono text-white/90">{fmt(totalSupply, 2)}</div>
        </div>
      </div>

      <div className="mt-4 inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5 text-xs">
        <button
          type="button"
          onClick={() => setMode('add')}
          className={`rounded-md px-3 py-1.5 ${
            mode === 'add'
              ? 'bg-emerald-500/15 text-emerald-200'
              : 'text-white/60 hover:text-white'
          }`}
        >
          Add liquidity
        </button>
        <button
          type="button"
          onClick={() => setMode('remove')}
          className={`rounded-md px-3 py-1.5 ${
            mode === 'remove'
              ? 'bg-emerald-500/15 text-emerald-200'
              : 'text-white/60 hover:text-white'
          }`}
        >
          Remove liquidity
        </button>
      </div>

      {mode === 'add' ? (
        <div className="mt-4 space-y-3">
          <AmountInput
            label="ETX"
            value={etxStr}
            onChange={setEtxStr}
            balance={etxBal}
          />
          <AmountInput
            label="stETX"
            value={stEtxStr}
            onChange={setStEtxStr}
            balance={stEtxBal}
          />
          <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/70">
            <div className="flex justify-between">
              <span>Estimated LP shares</span>
              <span className="font-mono text-white/90">
                {lpEstimate > 0n ? fmt(lpEstimate, 4) : '—'}
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-white/40">
              <span>Min received (0.50% slippage)</span>
              <span className="font-mono">
                {minMintAmount > 0n ? fmt(minMintAmount, 4) : '—'}
              </span>
            </div>
          </div>
          <p className="text-[11px] text-white/40">
            Unbalanced deposits are accepted. The pool prices the imbalance via
            the curve invariant; a small per-deposit fee may apply when the
            ratio drifts away from NAV.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <AmountInput
            label="LP shares to burn"
            value={lpStr}
            onChange={setLpStr}
            balance={lpBalance}
            balanceLabel="Your LP"
          />
          <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/70">
            <div className="flex justify-between">
              <span>You receive</span>
              <span className="font-mono text-white/90">
                {removeQuote
                  ? `${fmt(removeQuote.etx, 4)} ETX + ${fmt(
                      removeQuote.stEtx,
                      4,
                    )} stETX`
                  : '—'}
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-white/40">
              <span>Min received (0.50% slippage)</span>
              <span className="font-mono">
                {minRemoveOut
                  ? `${fmt(minRemoveOut.etx, 4)} ETX + ${fmt(
                      minRemoveOut.stEtx,
                      4,
                    )} stETX`
                  : '—'}
              </span>
            </div>
          </div>
          <p className="text-[11px] text-white/40">
            Pro-rata withdraw. Returns your share of both reserves at current
            ratio — no curve math, no slippage in normal conditions.
          </p>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {!isConnected && (
          <div className="rounded-md bg-white/5 px-3 py-2 text-xs text-white/60">
            Connect your wallet to add or remove liquidity.
          </div>
        )}

        {isConnected && mode === 'add' && etxNeedsApproval && (
          <button
            type="button"
            onClick={() => onApprove('etx')}
            disabled={isTxPending || receipt.isLoading}
            className="w-full rounded-md bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-60"
          >
            {isTxPending ? 'Confirm in wallet…' : 'Approve ETX'}
          </button>
        )}

        {isConnected &&
          mode === 'add' &&
          !etxNeedsApproval &&
          stEtxNeedsApproval && (
            <button
              type="button"
              onClick={() => onApprove('stetx')}
              disabled={isTxPending || receipt.isLoading}
              className="w-full rounded-md bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-60"
            >
              {isTxPending ? 'Confirm in wallet…' : 'Approve stETX'}
            </button>
          )}

        {isConnected &&
          mode === 'add' &&
          !etxNeedsApproval &&
          !stEtxNeedsApproval && (
            <button
              type="button"
              onClick={onAdd}
              disabled={
                isTxPending ||
                receipt.isLoading ||
                (amountEtx === 0n && amountStEtx === 0n) ||
                !hasEnoughEtx ||
                !hasEnoughStEtx
              }
              className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
            >
              {!hasEnoughEtx
                ? 'Insufficient ETX'
                : !hasEnoughStEtx
                ? 'Insufficient stETX'
                : isTxPending
                ? 'Confirm in wallet…'
                : receipt.isLoading
                ? 'Pending…'
                : 'Add liquidity'}
            </button>
          )}

        {isConnected && mode === 'remove' && (
          <button
            type="button"
            onClick={onRemove}
            disabled={
              isTxPending ||
              receipt.isLoading ||
              amountLp === 0n ||
              !hasEnoughLp
            }
            className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
          >
            {!hasEnoughLp
              ? 'Insufficient LP'
              : isTxPending
              ? 'Confirm in wallet…'
              : receipt.isLoading
              ? 'Pending…'
              : 'Remove liquidity'}
          </button>
        )}
      </div>

      {(submitError || txStatus || activeHash) && (
        <div className="mt-3 text-xs">
          {submitError && (
            <div className="rounded-md bg-rose-500/10 px-3 py-2 text-rose-200">
              {submitError}
            </div>
          )}
          {!submitError && txStatus === 'pending' && activeHash && (
            <div className="text-white/60">
              Pending:{' '}
              <a
                href={`https://eticascan.org/tx/${activeHash}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-emerald-400 hover:underline"
              >
                {activeHash.slice(0, 10)}…{activeHash.slice(-6)}
              </a>
            </div>
          )}
          {!submitError && txStatus === 'confirmed' && activeHash && (
            <div className="text-emerald-400">
              Confirmed:{' '}
              <a
                href={`https://eticascan.org/tx/${activeHash}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono hover:underline"
              >
                {activeHash.slice(0, 10)}…{activeHash.slice(-6)}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AmountInput(props: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  balance: bigint;
  balanceLabel?: string;
}) {
  const { label, value, onChange, balance, balanceLabel = 'Balance' } = props;
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-baseline justify-between text-[11px] text-white/50">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => onChange(formatUnits(balance, 18))}
          className="hover:text-emerald-300"
        >
          {balanceLabel}: <span className="font-mono">{fmt(balance, 4)}</span>
        </button>
      </div>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-transparent text-lg font-medium tabular-nums focus:outline-none"
      />
    </div>
  );
}
