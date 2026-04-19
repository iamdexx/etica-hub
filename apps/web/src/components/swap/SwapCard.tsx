'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatUnits, parseUnits, type Address, type Hex } from 'viem';
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';

type TokenSymbol = 'EGAZ' | 'ETI';

type Direction = {
  fromSymbol: TokenSymbol;
  toSymbol: TokenSymbol;
};

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.50%

function useTokens() {
  const chainId = useChainId();
  return useMemo(() => {
    if (!isSupportedChainId(chainId)) return null;
    const deployed = DEPLOYMENTS[chainId];
    const external = EXTERNAL_ADDRESSES[chainId];
    if (deployed.swapRouter === ZERO) return null;
    return {
      chainId,
      router: deployed.swapRouter,
      factory: deployed.swapFactory,
      wegaz: deployed.wegaz,
      eti: external.eti,
    };
  }, [chainId]);
}

export function SwapCard() {
  const { address, isConnected } = useAccount();
  const ctx = useTokens();
  const [dir, setDir] = useState<Direction>({ fromSymbol: 'EGAZ', toSymbol: 'ETI' });
  const [amountInStr, setAmountInStr] = useState('');

  const amountIn = useMemo(() => {
    if (!amountInStr) return 0n;
    try {
      return parseUnits(amountInStr, 18);
    } catch {
      return 0n;
    }
  }, [amountInStr]);

  const fromIsNative = dir.fromSymbol === 'EGAZ';
  const toIsNative = dir.toSymbol === 'EGAZ';

  const nativeBal = useBalance({
    address,
    query: { enabled: Boolean(address && ctx) },
  });

  const eti = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.eti,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && ctx) },
  });

  const allowance = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.eti,
    functionName: 'allowance',
    args: address && ctx ? [address, ctx.router] : undefined,
    query: { enabled: Boolean(address && ctx) && !fromIsNative },
  });

  const path = useMemo<Address[] | null>(() => {
    if (!ctx) return null;
    if (fromIsNative) return [ctx.wegaz, ctx.eti];
    if (toIsNative) return [ctx.eti, ctx.wegaz];
    return null;
  }, [ctx, fromIsNative, toIsNative]);

  const quote = useReadContract({
    abi: abis.routerAbi,
    address: ctx?.router,
    functionName: 'getAmountsOut',
    args: path && amountIn > 0n ? [amountIn, path] : undefined,
    query: { enabled: Boolean(ctx && path && amountIn > 0n) },
  });

  const amountOut = useMemo<bigint>(() => {
    const data = quote.data as bigint[] | undefined;
    if (!data || data.length < 2) return 0n;
    return data[data.length - 1];
  }, [quote.data]);

  const amountOutMin = useMemo<bigint>(() => {
    if (amountOut === 0n) return 0n;
    return (amountOut * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  }, [amountOut]);

  const fromBal = fromIsNative
    ? (nativeBal.data?.value ?? 0n)
    : ((eti.data as bigint | undefined) ?? 0n);
  const toBal = toIsNative
    ? (nativeBal.data?.value ?? 0n)
    : ((eti.data as bigint | undefined) ?? 0n);

  const needsApproval = !fromIsNative
    && amountIn > 0n
    && ((allowance.data as bigint | undefined) ?? 0n) < amountIn;

  const hasEnoughBalance = fromBal >= amountIn;

  const { writeContractAsync, data: txHash, isPending: isTxPending, reset: resetWrite } =
    useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<Hex | undefined>();
  const activeHash = pendingTxHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({
    hash: activeHash,
    query: { enabled: Boolean(activeHash) },
  });

  async function onApprove() {
    if (!ctx || !address) return;
    const hash = await writeContractAsync({
      abi: abis.erc20Abi,
      address: ctx.eti,
      functionName: 'approve',
      args: [ctx.router, MAX_UINT256],
    });
    setPendingTxHash(hash);
  }

  async function onSwap() {
    if (!ctx || !address || !path || amountIn === 0n) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

    let hash: Hex;
    if (fromIsNative) {
      hash = await writeContractAsync({
        abi: abis.routerAbi,
        address: ctx.router,
        functionName: 'swapExactEGAZForTokens',
        args: [amountOutMin, path, address, deadline],
        value: amountIn,
      });
    } else {
      hash = await writeContractAsync({
        abi: abis.routerAbi,
        address: ctx.router,
        functionName: 'swapExactTokensForEGAZ',
        args: [amountIn, amountOutMin, path, address, deadline],
      });
    }
    setPendingTxHash(hash);
  }

  // Refetch balances / allowance / quote only AFTER the tx is mined.
  // Running this on submit would read pre-tx state and (for approvals)
  // leave the UI showing both "Confirmed" and the Approve button at the
  // same time until react-query's passive refetch fires.
  useEffect(() => {
    if (!receipt.isSuccess) return;
    void Promise.all([
      nativeBal.refetch(),
      eti.refetch(),
      allowance.refetch(),
      quote.refetch(),
    ]).catch(() => {
      // best-effort; react-query will reconcile on the next block anyway
    });
    // We only want this side effect once per confirmed tx. The refetch
    // fns are stable identities from the hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, activeHash]);

  function onFlip() {
    setDir((d) => ({ fromSymbol: d.toSymbol, toSymbol: d.fromSymbol }));
    setAmountInStr('');
    setPendingTxHash(undefined);
    resetWrite();
  }

  const priceImpactText = usePriceImpact(ctx, fromIsNative, amountIn, amountOut);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/70">Swap</h2>
        <span className="text-xs text-white/40">v2 · 0.30% fee</span>
      </div>

      <div className="mt-4 space-y-2">
        <TokenInput
          label="From"
          symbol={dir.fromSymbol}
          balance={fromBal}
          amount={amountInStr}
          editable
          onAmount={setAmountInStr}
        />

        <div className="flex justify-center">
          <button
            onClick={onFlip}
            className="rounded-full border border-white/10 bg-white/10 p-2 text-white/70 hover:bg-white/20"
            title="Flip direction"
          >
            ↓
          </button>
        </div>

        <TokenInput
          label="To"
          symbol={dir.toSymbol}
          balance={toBal}
          amount={amountOut === 0n ? '' : formatUnits(amountOut, 18)}
          editable={false}
        />
      </div>

      <dl className="mt-3 space-y-1 text-xs text-white/50">
        <Row k="Route">
          {dir.fromSymbol} → {dir.toSymbol}
        </Row>
        <Row k="Min received">
          {amountOutMin === 0n
            ? '—'
            : `${truncate(formatUnits(amountOutMin, 18), 8)} ${dir.toSymbol}`}
        </Row>
        <Row k="Slippage">0.50%</Row>
        {priceImpactText && <Row k="Price impact">{priceImpactText}</Row>}
      </dl>

      <SwapButton
        isConnected={isConnected}
        ctx={ctx}
        amountIn={amountIn}
        amountOut={amountOut}
        hasEnoughBalance={hasEnoughBalance}
        needsApproval={needsApproval}
        isTxPending={isTxPending || receipt.isLoading}
        onApprove={onApprove}
        onSwap={onSwap}
      />

      {activeHash && receipt.isSuccess && (
        <p className="mt-3 break-all text-center text-xs text-emerald-400">
          Confirmed · tx {activeHash.slice(0, 10)}…{activeHash.slice(-8)}
        </p>
      )}
      {activeHash && receipt.isError && (
        <p className="mt-3 text-center text-xs text-rose-400">Transaction reverted.</p>
      )}
    </div>
  );
}

function TokenInput(props: {
  label: string;
  symbol: TokenSymbol;
  balance: bigint;
  amount: string;
  editable: boolean;
  onAmount?: (v: string) => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <input
          value={props.amount}
          disabled={!props.editable}
          onChange={(e) => props.onAmount?.(sanitizeNumber(e.target.value))}
          inputMode="decimal"
          placeholder="0.0"
          className="w-full bg-transparent text-2xl outline-none placeholder:text-white/30 disabled:cursor-default"
          aria-label={`${props.label} amount`}
        />
        <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
          {props.symbol}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-white/40">
        <span>{props.label}</span>
        <button
          onClick={() =>
            props.editable && props.onAmount?.(formatUnits(props.balance, 18))
          }
          disabled={!props.editable}
          className="hover:text-white/80 disabled:cursor-default disabled:hover:text-white/40"
        >
          Balance: {truncate(formatUnits(props.balance, 18), 6)}
        </button>
      </div>
    </div>
  );
}

function Row(props: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <dt>{props.k}</dt>
      <dd className="text-white/80">{props.children}</dd>
    </div>
  );
}

function SwapButton(props: {
  isConnected: boolean;
  ctx: ReturnType<typeof useTokens>;
  amountIn: bigint;
  amountOut: bigint;
  hasEnoughBalance: boolean;
  needsApproval: boolean;
  isTxPending: boolean;
  onApprove: () => Promise<void>;
  onSwap: () => Promise<void>;
}) {
  const base =
    'mt-4 w-full rounded-xl py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed';
  const active = 'bg-brand-accent text-brand-ink hover:opacity-90';
  const subdued = 'bg-white/10 text-white/60';

  if (!props.isConnected) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Connect wallet to continue
      </button>
    );
  }
  if (!props.ctx) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        EticaSwap not deployed on this chain
      </button>
    );
  }
  if (props.amountIn === 0n) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Enter an amount
      </button>
    );
  }
  if (!props.hasEnoughBalance) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Insufficient balance
      </button>
    );
  }
  if (props.amountOut === 0n) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Fetching quote…
      </button>
    );
  }
  if (props.needsApproval) {
    return (
      <button
        onClick={props.onApprove}
        disabled={props.isTxPending}
        className={`${base} ${active}`}
      >
        {props.isTxPending ? 'Approving…' : 'Approve ETI'}
      </button>
    );
  }
  return (
    <button
      onClick={props.onSwap}
      disabled={props.isTxPending}
      className={`${base} ${active}`}
    >
      {props.isTxPending ? 'Swapping…' : 'Swap'}
    </button>
  );
}

function usePriceImpact(
  ctx: ReturnType<typeof useTokens>,
  fromIsNative: boolean,
  amountIn: bigint,
  amountOut: bigint,
): string | null {
  const reserves = useReadContracts({
    contracts:
      ctx && amountIn > 0n
        ? [
            {
              abi: abis.factoryAbi,
              address: ctx.factory,
              functionName: 'getPair',
              args: [ctx.eti, ctx.wegaz],
            },
          ]
        : [],
    query: { enabled: Boolean(ctx && amountIn > 0n) },
  });
  const pair = reserves.data?.[0]?.result as Address | undefined;

  const pairState = useReadContracts({
    contracts:
      pair && pair !== ZERO
        ? [
            { abi: abis.pairAbi, address: pair, functionName: 'getReserves' },
            { abi: abis.pairAbi, address: pair, functionName: 'token0' },
          ]
        : [],
    query: { enabled: Boolean(pair && pair !== ZERO) },
  });

  if (!ctx || amountIn === 0n || amountOut === 0n) return null;
  const reservesData = pairState.data?.[0]?.result as
    | readonly [bigint, bigint, number]
    | undefined;
  const token0 = pairState.data?.[1]?.result as Address | undefined;
  if (!reservesData || !token0) return null;

  const wegazIsToken0 = token0.toLowerCase() === ctx.wegaz.toLowerCase();
  const egazReserve = wegazIsToken0 ? reservesData[0] : reservesData[1];
  const etiReserve = wegazIsToken0 ? reservesData[1] : reservesData[0];
  if (egazReserve === 0n || etiReserve === 0n) return null;

  // Mid price (no-fee) vs executed price; report as %.
  const mid = fromIsNative ? (etiReserve * 10n ** 18n) / egazReserve : (egazReserve * 10n ** 18n) / etiReserve;
  const exec = (amountOut * 10n ** 18n) / amountIn;
  if (mid === 0n) return null;
  // impact = (mid - exec) / mid
  const impactBps = ((mid - exec) * 10_000n) / mid;
  if (impactBps < 0n) return '≈ 0.00%';
  return `${(Number(impactBps) / 100).toFixed(2)}%`;
}

function truncate(s: string, maxDecimals: number): string {
  const [whole, frac = ''] = s.split('.');
  if (!frac) return whole;
  return `${whole}.${frac.slice(0, maxDecimals)}`;
}

function sanitizeNumber(v: string): string {
  // allow only digits and a single dot
  const cleaned = v.replace(/[^\d.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
}
