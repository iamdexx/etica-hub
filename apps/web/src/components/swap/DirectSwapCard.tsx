'use client';

/**
 * EticaSwap Direct (V5) swap card. Trades go straight to a Direct window
 * (`EticaDirectMetaPair.swapExactIn`): the window charges the trader's
 * stETX-tier fee off the input, settles the rest on the ETX hub pools and
 * forwards the output. Windows hold hub LP, not reserves of their own, so
 * the quote is the hub's own quote (`quoteOut`).
 *
 * Gate: the factory only lets wallets holding `minStEtx` stETX trade
 * (`isAllowed`). Below the gate the card shows the ladder and a stake link.
 * The EGAZ leg of a window is WEGAZ, so the card offers a one-click wrap
 * when the wallet holds native EGAZ but not enough WEGAZ.
 */

import Link from 'next/link';
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
  useBalance,
  useChainId,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { supportedChains } from '@etica-hub/shared/chains';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  USDC_WARP_ROUTE,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';
import { directFactoryArtifact, directMetaPairArtifact } from '@/lib/direct-deploy-artifacts';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const SLIPPAGE_BPS = 50n; // 0.50%
const MAX_WINDOWS = 12;

type Ctx = {
  factory: Address;
  wegaz: Address;
  eti: Address;
  etx: Address;
  stetx: Address;
  usdce: Address;
};

type TokenMeta = { symbol: string; decimals: number; native: boolean };

type Window = {
  pair: Address;
  token0: Address;
  token1: Address;
  open: boolean;
};

function useCtx(): Ctx | null {
  const chainId = useChainId();
  return useMemo(() => {
    if (!isSupportedChainId(chainId)) return null;
    const d = DEPLOYMENTS[chainId];
    const e = EXTERNAL_ADDRESSES[chainId];
    if (d.directFactory === ZERO) return null;
    return {
      factory: d.directFactory,
      wegaz: d.wegaz,
      eti: e.eti,
      etx: d.etx,
      stetx: d.stakedETX,
      usdce: USDC_WARP_ROUTE.syntheticToken,
    };
  }, [chainId]);
}

function tokenMeta(ctx: Ctx, token: Address): TokenMeta {
  const t = token.toLowerCase();
  if (t === ctx.wegaz.toLowerCase()) return { symbol: 'EGAZ', decimals: 18, native: true };
  if (t === ctx.eti.toLowerCase()) return { symbol: 'ETI', decimals: 18, native: false };
  if (t === ctx.etx.toLowerCase()) return { symbol: 'ETX', decimals: 18, native: false };
  if (t === ctx.usdce.toLowerCase())
    return { symbol: 'USDC.e', decimals: USDC_WARP_ROUTE.decimals, native: false };
  if (t === ctx.stetx.toLowerCase()) return { symbol: 'stETX', decimals: 18, native: false };
  return { symbol: `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: 18, native: false };
}

function fmt(n: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(n, decimals);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
}

function fmtCompact(n: bigint): string {
  const whole = Number(n / 10n ** 18n);
  return whole >= 1000 ? `${Math.round(whole / 1000)}k` : String(whole);
}

function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2)}%`;
}

function sanitizeNumber(raw: string, decimals: number): string {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const [i, ...rest] = cleaned.split('.');
  if (rest.length === 0) return i;
  return `${i}.${rest.join('').slice(0, decimals)}`;
}

function describeWriteError(err: unknown, fallback: string): string | undefined {
  if (err instanceof UserRejectedRequestError) return undefined;
  if (err instanceof BaseError) {
    const short = err.shortMessage || err.message;
    if (/user rejected|denied/i.test(short)) return undefined;
    return short;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export function DirectSwapCard() {
  const ctx = useCtx();
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const dappChainId = useChainId();
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain();
  const onWrongNetwork =
    isConnected && walletChainId !== undefined && walletChainId !== dappChainId;
  const dappChainName = supportedChains.find((c) => c.id === dappChainId)?.name ?? 'Etica Mainnet';

  const factoryAbi = directFactoryArtifact.abi;
  const pairAbi = directMetaPairArtifact.abi;

  // ---- windows
  const pairCount = useReadContract({
    abi: factoryAbi,
    address: ctx?.factory,
    functionName: 'allPairsLength',
    query: { enabled: Boolean(ctx) },
  });
  const count = Math.min(Number((pairCount.data as bigint | undefined) ?? 0n), MAX_WINDOWS);
  const pairAddrs = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      abi: factoryAbi,
      address: ctx?.factory ?? ZERO,
      functionName: 'allPairs' as const,
      args: [BigInt(i)],
    })),
    query: { enabled: Boolean(ctx && count > 0) },
  });
  const pairs = useMemo<Address[]>(
    () =>
      (pairAddrs.data ?? [])
        .map((r) => (r.status === 'success' ? (r.result as Address) : null))
        .filter((a): a is Address => Boolean(a)),
    [pairAddrs.data],
  );
  const pairInfo = useReadContracts({
    contracts: pairs.flatMap((pair) => [
      { abi: pairAbi, address: pair, functionName: 'token0' as const },
      { abi: pairAbi, address: pair, functionName: 'token1' as const },
      { abi: factoryAbi, address: ctx?.factory ?? ZERO, functionName: 'isMetaPair' as const, args: [pair] },
      { abi: factoryAbi, address: ctx?.factory ?? ZERO, functionName: 'retired' as const, args: [pair] },
      { abi: factoryAbi, address: ctx?.factory ?? ZERO, functionName: 'swapsOpen' as const, args: [pair] },
    ]),
    query: { enabled: Boolean(ctx && pairs.length > 0) },
  });
  const windows = useMemo<Window[]>(() => {
    const rows = pairInfo.data;
    if (!rows) return [];
    const out: Window[] = [];
    pairs.forEach((pair, i) => {
      const r = rows.slice(i * 5, i * 5 + 5);
      if (r.some((x) => x.status !== 'success')) return;
      const [token0, token1, isMeta, retired, open] = r.map((x) => x.result) as [
        Address,
        Address,
        boolean,
        boolean,
        boolean,
      ];
      if (!isMeta || retired) return;
      out.push({ pair, token0, token1, open });
    });
    return out;
  }, [pairInfo.data, pairs]);

  const [pairSel, setPairSel] = useState<Address | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [amountInStr, setAmountInStr] = useState('');
  const win = windows.find((w) => w.pair === pairSel) ?? windows[0] ?? null;

  // Default direction: dollars in, asset out.
  const usdcIsToken0 = Boolean(
    win && ctx && win.token0.toLowerCase() === ctx.usdce.toLowerCase(),
  );
  const usdcIsToken1 = Boolean(
    win && ctx && win.token1.toLowerCase() === ctx.usdce.toLowerCase(),
  );
  const inIsToken0 = (usdcIsToken0 || !usdcIsToken1) !== flipped;
  const tokenIn = win ? (inIsToken0 ? win.token0 : win.token1) : null;
  const tokenOut = win ? (inIsToken0 ? win.token1 : win.token0) : null;
  const metaIn = ctx && tokenIn ? tokenMeta(ctx, tokenIn) : null;
  const metaOut = ctx && tokenOut ? tokenMeta(ctx, tokenOut) : null;

  const amountIn = useMemo(() => {
    if (!amountInStr || !metaIn) return 0n;
    try {
      return parseUnits(amountInStr, metaIn.decimals);
    } catch {
      return 0n;
    }
  }, [amountInStr, metaIn]);

  // ---- gate + fee
  const gate = useReadContracts({
    contracts: [
      { abi: factoryAbi, address: ctx?.factory ?? ZERO, functionName: 'minStEtx' as const },
      { abi: factoryAbi, address: ctx?.factory ?? ZERO, functionName: 'feeTierCount' as const },
      {
        abi: factoryAbi,
        address: ctx?.factory ?? ZERO,
        functionName: 'isAllowed' as const,
        args: [address ?? ZERO],
      },
      {
        abi: factoryAbi,
        address: ctx?.factory ?? ZERO,
        functionName: 'feeBpsFor' as const,
        args: [address ?? ZERO],
      },
      {
        abi: abis.erc20Abi,
        address: ctx?.stetx ?? ZERO,
        functionName: 'balanceOf' as const,
        args: [address ?? ZERO],
      },
    ],
    query: { enabled: Boolean(ctx) },
  });
  const minStEtx = (gate.data?.[0]?.result as bigint | undefined) ?? 0n;
  const tierCount = Number((gate.data?.[1]?.result as bigint | undefined) ?? 0n);
  const allowed = address ? Boolean(gate.data?.[2]?.result) : false;
  const feeBps = address ? Number((gate.data?.[3]?.result as number | undefined) ?? 0) : null;
  const stetxBal = address ? ((gate.data?.[4]?.result as bigint | undefined) ?? 0n) : 0n;

  const tiers = useReadContracts({
    contracts: Array.from({ length: Math.min(tierCount, 8) }, (_, i) => ({
      abi: factoryAbi,
      address: ctx?.factory ?? ZERO,
      functionName: 'feeTier' as const,
      args: [BigInt(i)],
    })),
    query: { enabled: Boolean(ctx && tierCount > 0) },
  });
  const ladder = useMemo(
    () =>
      (tiers.data ?? [])
        .map((r) => (r.status === 'success' ? (r.result as [bigint, number]) : null))
        .filter((x): x is [bigint, number] => Boolean(x)),
    [tiers.data],
  );

  // ---- balances, allowance, quote
  const nativeBal = useBalance({ address, query: { enabled: Boolean(address && ctx) } });
  const inBal = useReadContract({
    abi: abis.erc20Abi,
    address: tokenIn ?? undefined,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && tokenIn) },
  });
  const outBal = useReadContract({
    abi: abis.erc20Abi,
    address: tokenOut ?? undefined,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && tokenOut) },
  });
  const allowance = useReadContract({
    abi: abis.erc20Abi,
    address: tokenIn ?? undefined,
    functionName: 'allowance',
    args: address && win ? [address, win.pair] : undefined,
    query: { enabled: Boolean(address && tokenIn && win) },
  });
  const quote = useReadContract({
    abi: pairAbi,
    address: win?.pair,
    functionName: 'quoteOut',
    args: tokenIn && address ? [tokenIn, amountIn, address] : undefined,
    query: { enabled: Boolean(win && tokenIn && address && amountIn > 0n && allowed) },
  });
  const amountOut = (quote.data as bigint | undefined) ?? 0n;
  const amountOutMin = amountOut === 0n ? 0n : (amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const fromBal = (inBal.data as bigint | undefined) ?? 0n;
  const toBal = (outBal.data as bigint | undefined) ?? 0n;
  const native = nativeBal.data?.value ?? 0n;
  const shortfall = amountIn > fromBal ? amountIn - fromBal : 0n;
  const canWrap = Boolean(metaIn?.native && shortfall > 0n && native > shortfall);
  const hasEnough = shortfall === 0n;
  const needsApproval =
    amountIn > 0n && ((allowance.data as bigint | undefined) ?? 0n) < amountIn;

  // ---- writes
  const { writeContractAsync, isPending: isTxPending, reset: resetWrite } = useWriteContract();
  const [pendingHash, setPendingHash] = useState<Hex | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const receipt = useWaitForTransactionReceipt({
    hash: pendingHash,
    query: { enabled: Boolean(pendingHash) },
  });

  async function send(label: string, fn: () => Promise<Hex>) {
    setSubmitError(undefined);
    setPendingHash(undefined);
    resetWrite();
    try {
      setPendingHash(await fn());
    } catch (err) {
      setSubmitError(describeWriteError(err, `${label} failed`));
    }
  }

  const onWrap = () =>
    send('Wrap', () =>
      writeContractAsync({
        abi: abis.wegazAbi,
        address: ctx!.wegaz,
        functionName: 'deposit',
        value: shortfall,
      }),
    );
  const onApprove = () =>
    send('Approval', () =>
      writeContractAsync({
        abi: abis.erc20Abi,
        address: tokenIn!,
        functionName: 'approve',
        args: [win!.pair, MAX_UINT256],
      }),
    );
  const onSwap = () =>
    send('Swap', () =>
      writeContractAsync({
        abi: pairAbi,
        address: win!.pair,
        functionName: 'swapExactIn',
        args: [
          tokenIn!,
          amountIn,
          amountOutMin,
          address!,
          BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
        ],
      }),
    );

  useEffect(() => {
    if (!receipt.isSuccess) return;
    void Promise.all([
      nativeBal.refetch(),
      inBal.refetch(),
      outBal.refetch(),
      allowance.refetch(),
      quote.refetch(),
      gate.refetch(),
    ]).catch(() => {
      // best-effort
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, pendingHash]);

  // ---- render
  if (!ctx) {
    return (
      <Card>
        <p className="text-sm text-white/55">
          EticaSwap Direct is live on Etica Mainnet only. Switch your wallet to Etica to trade.
        </p>
      </Card>
    );
  }

  const busy = isTxPending || receipt.isLoading;
  const base =
    'mt-4 w-full rounded-xl py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed';
  const active = 'bg-brand-accent text-brand-ink hover:opacity-90';
  const warn = 'bg-amber-400 text-black hover:bg-amber-300';
  const subdued = 'bg-white/10 text-white/60';

  let button: React.ReactNode;
  if (!isConnected) {
    button = <button disabled className={`${base} ${subdued}`}>Connect wallet to continue</button>;
  } else if (onWrongNetwork) {
    button = (
      <button
        onClick={() => switchChain({ chainId: dappChainId })}
        disabled={isSwitchingChain}
        className={`${base} ${warn}`}
      >
        {isSwitchingChain ? 'Switching…' : `Switch to ${dappChainName}`}
      </button>
    );
  } else if (gate.isLoading) {
    button = <button disabled className={`${base} ${subdued}`}>Checking stETX tier…</button>;
  } else if (!allowed) {
    button = (
      <Link href="/stake" className={`${base} block text-center ${warn}`}>
        Hold {fmtCompact(minStEtx)} stETX to trade here · Stake
      </Link>
    );
  } else if (!win) {
    button = <button disabled className={`${base} ${subdued}`}>No open windows</button>;
  } else if (!win.open) {
    button = <button disabled className={`${base} ${subdued}`}>Trading paused by the watcher</button>;
  } else if (amountIn === 0n) {
    button = <button disabled className={`${base} ${subdued}`}>Enter an amount</button>;
  } else if (canWrap) {
    button = (
      <button onClick={onWrap} disabled={busy} className={`${base} ${warn}`}>
        {busy ? 'Confirming…' : `Wrap ${fmt(shortfall, 18, 4)} EGAZ`}
      </button>
    );
  } else if (!hasEnough) {
    button = <button disabled className={`${base} ${subdued}`}>Insufficient {metaIn?.symbol}</button>;
  } else if (needsApproval) {
    button = (
      <button onClick={onApprove} disabled={busy} className={`${base} ${warn}`}>
        {busy ? 'Confirming…' : `Approve ${metaIn?.symbol}`}
      </button>
    );
  } else {
    button = (
      <button onClick={onSwap} disabled={busy || amountOut === 0n} className={`${base} ${active}`}>
        {busy ? 'Confirming…' : 'Swap'}
      </button>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/70">Direct</h2>
        <span className="text-xs text-white/40">
          v5 · {feeBps !== null && allowed ? `${fmtBps(feeBps)} fee` : 'stETX-tiered fee'} · settles on the ETX hub
        </span>
      </div>

      {windows.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {windows.map((w) => {
            const a = tokenMeta(ctx, w.token0).symbol;
            const b = tokenMeta(ctx, w.token1).symbol;
            const isActive = win?.pair === w.pair;
            return (
              <button
                key={w.pair}
                type="button"
                onClick={() => {
                  setPairSel(w.pair);
                  setAmountInStr('');
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  isActive
                    ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200'
                    : 'border-white/[0.08] bg-white/[0.03] text-white/55 hover:border-white/20 hover:text-white/80'
                }`}
              >
                {a} / {b}
                {!w.open && <span className="ml-1.5 text-amber-300">paused</span>}
              </button>
            );
          })}
        </div>
      )}

      {win && metaIn && metaOut ? (
        <div className="mt-4 space-y-2">
          <AmountBox
            label="From"
            symbol={metaIn.symbol}
            balance={fromBal}
            decimals={metaIn.decimals}
            amount={amountInStr}
            onAmount={(v) => setAmountInStr(sanitizeNumber(v, metaIn.decimals))}
            onMax={() => setAmountInStr(formatUnits(fromBal, metaIn.decimals))}
            hint={metaIn.native ? `WEGAZ · ${fmt(native, 18, 4)} EGAZ unwrapped` : undefined}
          />
          <div className="flex justify-center">
            <button
              onClick={() => {
                setFlipped((f) => !f);
                setAmountInStr('');
              }}
              className="rounded-full border border-white/[0.07] bg-white/10 p-2 text-white/70 hover:bg-white/20"
              title="Flip direction"
            >
              ↓
            </button>
          </div>
          <AmountBox
            label="To"
            symbol={metaOut.symbol}
            balance={toBal}
            decimals={metaOut.decimals}
            amount={amountOut === 0n ? '' : fmt(amountOut, metaOut.decimals, 8)}
          />
        </div>
      ) : (
        <p className="mt-4 text-sm text-white/55">
          {pairCount.isLoading || pairInfo.isLoading ? 'Loading windows…' : 'No Direct windows are open yet.'}
        </p>
      )}

      <dl className="mt-3 space-y-1 text-xs text-white/50">
        <Row k="Route">
          {metaIn && metaOut ? `${metaIn.symbol} → ETX hub → ${metaOut.symbol}` : '—'}
        </Row>
        <Row k="Your tier">
          {!address
            ? '—'
            : allowed && feeBps !== null
              ? `${fmt(stetxBal, 18, 0)} stETX · ${fmtBps(feeBps)} fee`
              : `${fmt(stetxBal, 18, 0)} stETX · below the ${fmtCompact(minStEtx)} gate`}
        </Row>
        <Row k="Min received">
          {amountOutMin === 0n || !metaOut ? '—' : `${fmt(amountOutMin, metaOut.decimals, 8)} ${metaOut.symbol}`}
        </Row>
        <Row k="Slippage">0.50%</Row>
      </dl>

      {ladder.length > 0 && (
        <p className="mt-3 text-[11px] leading-5 text-white/40">
          Fee by stETX held:{' '}
          {ladder.map(([min, bps], i) => (
            <span key={min.toString()}>
              {i > 0 && ' · '}
              {fmtBps(bps)} at {fmtCompact(min)}
            </span>
          ))}
          . Windows hold no liquidity of their own; every trade is two hub swaps.
        </p>
      )}

      {button}

      {pendingHash && receipt.isSuccess && (
        <p className="mt-3 break-all text-center text-xs text-emerald-400">
          Confirmed · tx {pendingHash.slice(0, 10)}…{pendingHash.slice(-8)}
        </p>
      )}
      {pendingHash && receipt.isError && (
        <p className="mt-3 text-center text-xs text-rose-400">Transaction reverted.</p>
      )}
      {submitError && (
        <p className="mt-3 break-words text-center text-xs text-rose-400">{submitError}</p>
      )}
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-5 shadow-xl">
      {children}
    </div>
  );
}

function Row(props: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt>{props.k}</dt>
      <dd className="text-right text-white/70">{props.children}</dd>
    </div>
  );
}

function AmountBox(props: {
  label: string;
  symbol: string;
  balance: bigint;
  decimals: number;
  amount: string;
  onAmount?: (v: string) => void;
  onMax?: () => void;
  hint?: string;
}) {
  const editable = Boolean(props.onAmount);
  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/30 p-3">
      <div className="flex items-center justify-between text-[11px] text-white/45">
        <span>{props.label}</span>
        <span>
          Balance {fmt(props.balance, props.decimals, 4)}
          {props.onMax && props.balance > 0n && (
            <button onClick={props.onMax} className="ml-2 text-emerald-300 hover:text-emerald-200">
              Max
            </button>
          )}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={props.amount}
          readOnly={!editable}
          onChange={(e) => props.onAmount?.(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-xl text-white outline-none placeholder:text-white/25"
        />
        <span className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white">
          {props.symbol}
        </span>
      </div>
      {props.hint && <div className="mt-1 text-[11px] text-white/35">{props.hint}</div>}
    </div>
  );
}
