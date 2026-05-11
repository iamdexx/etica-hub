'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  formatUnits,
  isAddress,
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
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';

type KnownSymbol = 'EGAZ' | 'ETI' | 'ETX';
type BSymbol = KnownSymbol | 'CUSTOM';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.50%
const PAIR_CREATION_FEE_HEADROOM = 10_000n * 10n ** 18n;

type Ctx = {
  chainId: number;
  router: Address;
  factory: Address;
  wegaz: Address;
  eti: Address;
  etx: Address;
  stetx: Address;
};

function useCtx(): Ctx | null {
  const chainId = useChainId();
  return useMemo(() => {
    if (!isSupportedChainId(chainId)) return null;
    const d = DEPLOYMENTS[chainId];
    const e = EXTERNAL_ADDRESSES[chainId];
    if (d.swapRouter === ZERO || d.etx === ZERO || d.wegaz === ZERO) return null;
    return {
      chainId,
      router: d.swapRouter,
      factory: d.swapFactory,
      wegaz: d.wegaz,
      eti: e.eti,
      etx: d.etx,
      stetx: d.stakedETX,
    };
  }, [chainId]);
}

function resolveAddr(ctx: Ctx, sym: KnownSymbol): Address {
  return sym === 'EGAZ' ? ctx.wegaz : sym === 'ETI' ? ctx.eti : ctx.etx;
}

export function PoolAddCard({
  geoRestricted = false,
}: { geoRestricted?: boolean } = {}) {
  const { address, isConnected } = useAccount();
  const ctx = useCtx();

  // Token A is locked to ETX (factory enforces ETX hub). Token B is freely
  // chosen from the known tokens plus a custom ERC20 slot.
  const [bSymbol, setBSymbol] = useState<BSymbol>('ETI');
  const [customB, setCustomB] = useState('');
  const [amountAStr, setAmountAStr] = useState('');
  const [amountBStr, setAmountBStr] = useState('');
  const [lastEdited, setLastEdited] = useState<'A' | 'B'>('A');

  // Geo-gated visitors cannot pair against stETX. If a custom address
  // resolves to the canonical stETX, treat the input as invalid so the
  // submit path stays disabled and the user sees an inline notice.
  const customBIsStEtx = useMemo(() => {
    if (!geoRestricted || !ctx || ctx.stetx === ZERO) return false;
    if (bSymbol !== 'CUSTOM') return false;
    const trimmed = customB.trim();
    if (!isAddress(trimmed)) return false;
    return trimmed.toLowerCase() === ctx.stetx.toLowerCase();
  }, [geoRestricted, ctx, bSymbol, customB]);

  const tokenB: Address | null = useMemo(() => {
    if (!ctx) return null;
    if (bSymbol === 'CUSTOM') {
      const trimmed = customB.trim();
      if (!isAddress(trimmed)) return null;
      if (customBIsStEtx) return null;
      return trimmed as Address;
    }
    return resolveAddr(ctx, bSymbol);
  }, [ctx, bSymbol, customB, customBIsStEtx]);

  const tokenA: Address | null = ctx ? ctx.etx : null;
  const bIsNative = bSymbol === 'EGAZ';

  // Read pair address, then (if exists) reserves + token0 so we can order
  // reserves against tokenA/tokenB.
  const pairQ = useReadContract({
    abi: abis.factoryAbi,
    address: ctx?.factory,
    functionName: 'getPair',
    args: tokenA && tokenB ? [tokenA, tokenB] : undefined,
    query: { enabled: Boolean(ctx && tokenA && tokenB) },
  });
  const pairAddress = ((pairQ.data as Address | undefined) ?? ZERO) as Address;
  const pairExists = pairAddress !== ZERO;

  const pairReads = useReadContracts({
    allowFailure: false,
    contracts: pairExists
      ? [
          {
            abi: abis.pairAbi,
            address: pairAddress,
            functionName: 'getReserves',
          } as const,
          {
            abi: abis.pairAbi,
            address: pairAddress,
            functionName: 'token0',
          } as const,
        ]
      : [],
    query: { enabled: pairExists },
  });

  const reserves = useMemo<{ rA: bigint; rB: bigint } | null>(() => {
    if (!pairExists) return null;
    const data = pairReads.data;
    if (!data || data.length < 2) return null;
    const [reservesRaw, token0Raw] = data as [
      readonly [bigint, bigint, number],
      Address,
    ];
    const [r0, r1] = reservesRaw;
    const aIs0 =
      tokenA && token0Raw.toLowerCase() === tokenA.toLowerCase();
    return aIs0 ? { rA: r0, rB: r1 } : { rA: r1, rB: r0 };
  }, [pairExists, pairReads.data, tokenA]);

  // B-token decimals + symbol (custom ERC20 support). Hoisted above the
  // auto-quote effect so the effect can parse / format amountB at the correct
  // precision for non-18-decimal tokens.
  const bMeta = useReadContracts({
    allowFailure: true,
    contracts:
      tokenB && !bIsNative
        ? [
            {
              abi: abis.erc20Abi,
              address: tokenB,
              functionName: 'decimals',
            } as const,
            {
              abi: abis.erc20Abi,
              address: tokenB,
              functionName: 'symbol',
            } as const,
          ]
        : [],
    query: { enabled: Boolean(tokenB && !bIsNative) },
  });
  const bDecimals = useMemo<number>(() => {
    if (bIsNative) return 18;
    const d = bMeta.data?.[0];
    if (!d || d.status !== 'success') return 18;
    return Number(d.result as number);
  }, [bIsNative, bMeta.data]);
  const bSymbolLabel = useMemo<string>(() => {
    if (bSymbol !== 'CUSTOM') return bSymbol;
    const s = bMeta.data?.[1];
    if (!s || s.status !== 'success') return 'custom';
    return s.result as string;
  }, [bSymbol, bMeta.data]);

  // Auto-quote: when the pair exists and user edits one side, derive the other
  // at the current pool ratio. When the pair does NOT exist the user sets the
  // initial price freely. Reserves are stored at each token's native decimals,
  // so we must parse / format amountB at bDecimals (not a hardcoded 18) for
  // custom ERC20s that aren't 18-decimal.
  useEffect(() => {
    if (!reserves || reserves.rA === 0n || reserves.rB === 0n) return;
    if (lastEdited === 'A') {
      if (!amountAStr) {
        setAmountBStr('');
        return;
      }
      try {
        const a = parseUnits(amountAStr, 18);
        const b = (a * reserves.rB) / reserves.rA;
        setAmountBStr(formatUnits(b, bDecimals));
      } catch {
        /* ignore parse errors */
      }
    } else {
      if (!amountBStr) {
        setAmountAStr('');
        return;
      }
      try {
        const b = parseUnits(amountBStr, bDecimals);
        const a = (b * reserves.rA) / reserves.rB;
        setAmountAStr(formatUnits(a, 18));
      } catch {
        /* ignore parse errors */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEdited, amountAStr, amountBStr, reserves?.rA, reserves?.rB, bDecimals]);

  const amountA = useMemo(() => {
    if (!amountAStr) return 0n;
    try {
      return parseUnits(amountAStr, 18);
    } catch {
      return 0n;
    }
  }, [amountAStr]);

  // Balances + allowances. We need ETX approval for both the liquidity
  // amount AND (if pair doesn't yet exist) the 10k ETX pair-creation fee.
  const nativeBal = useBalance({
    address,
    query: { enabled: Boolean(address && ctx) },
  });
  const etxBal = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.etx,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && ctx) },
  });
  const bBal = useReadContract({
    abi: abis.erc20Abi,
    address: tokenB && !bIsNative ? tokenB : undefined,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && ctx && tokenB && !bIsNative) },
  });
  const etxAllowance = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.etx,
    functionName: 'allowance',
    args: address && ctx ? [address, ctx.router] : undefined,
    query: { enabled: Boolean(address && ctx) },
  });
  const bAllowance = useReadContract({
    abi: abis.erc20Abi,
    address: tokenB && !bIsNative ? tokenB : undefined,
    functionName: 'allowance',
    args: address && ctx && tokenB ? [address, ctx.router] : undefined,
    query: { enabled: Boolean(address && ctx && tokenB && !bIsNative) },
  });
  // Re-parse amountB at the correct decimals if custom token is non-18.
  const amountBAdjusted = useMemo(() => {
    if (!amountBStr) return 0n;
    try {
      return parseUnits(amountBStr, bDecimals);
    } catch {
      return 0n;
    }
  }, [amountBStr, bDecimals]);

  const etxBalVal = (etxBal.data as bigint | undefined) ?? 0n;
  const bBalVal = bIsNative
    ? nativeBal.data?.value ?? 0n
    : (bBal.data as bigint | undefined) ?? 0n;
  const etxAllowanceVal = (etxAllowance.data as bigint | undefined) ?? 0n;
  const bAllowanceVal = (bAllowance.data as bigint | undefined) ?? 0n;

  // Total ETX the user must have spendable = liquidity amount + (pair fee if new).
  const etxNeedsTotal = useMemo(() => {
    let n = amountA;
    if (!pairExists) n += PAIR_CREATION_FEE_HEADROOM;
    return n;
  }, [amountA, pairExists]);

  const etxNeedsApproval = etxNeedsTotal > 0n && etxAllowanceVal < etxNeedsTotal;
  const bNeedsApproval =
    !bIsNative && amountBAdjusted > 0n && bAllowanceVal < amountBAdjusted;
  const hasEnoughEtx = etxBalVal >= etxNeedsTotal;
  const hasEnoughB = bBalVal >= amountBAdjusted;

  const { writeContractAsync, data: txHash, isPending: isTxPending, reset: resetWrite } =
    useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<Hex | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const activeHash = pendingTxHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({
    hash: activeHash,
    query: { enabled: Boolean(activeHash) },
  });

  useEffect(() => {
    if (!receipt.isSuccess) return;
    void Promise.all([
      nativeBal.refetch(),
      etxBal.refetch(),
      bBal.refetch(),
      etxAllowance.refetch(),
      bAllowance.refetch(),
      pairQ.refetch(),
      pairReads.refetch(),
    ]).catch(() => {
      /* best-effort */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, activeHash]);

  async function onApproveEtx() {
    if (!ctx) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: ctx.etx,
        functionName: 'approve',
        args: [ctx.router, MAX_UINT256],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'ETX approval failed'));
    }
  }

  async function onApproveB() {
    if (!ctx || !tokenB || bIsNative) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: tokenB,
        functionName: 'approve',
        args: [ctx.router, MAX_UINT256],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, `${bSymbolLabel} approval failed`));
    }
  }

  async function onAdd() {
    if (!ctx || !address || !tokenB) return;
    if (amountA === 0n || amountBAdjusted === 0n) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

    // Slippage: if pair exists, use DEFAULT_SLIPPAGE_BPS around the quote.
    // If pair doesn't exist, the user sets the price — accept exact amounts
    // (min = desired). In practice router re-quotes on reserve update, so
    // this is a belt-and-braces floor.
    const minA = pairExists
      ? (amountA * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n
      : amountA;
    const minB = pairExists
      ? (amountBAdjusted * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n
      : amountBAdjusted;

    try {
      let hash: Hex;
      if (bIsNative) {
        // router.addLiquidityEGAZ(token=ETX, amountTokenDesired=amountA, ...)
        hash = await writeContractAsync({
          abi: abis.routerAbi,
          address: ctx.router,
          functionName: 'addLiquidityEGAZ',
          args: [ctx.etx, amountA, minA, minB, address, deadline],
          value: amountBAdjusted,
        });
      } else {
        hash = await writeContractAsync({
          abi: abis.routerAbi,
          address: ctx.router,
          functionName: 'addLiquidity',
          args: [
            ctx.etx,
            tokenB,
            amountA,
            amountBAdjusted,
            minA,
            minB,
            address,
            deadline,
          ],
        });
      }
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Add liquidity failed'));
    }
  }

  const isWorking = isTxPending || receipt.isLoading;

  // NOTE: deliberately do not include etxNeedsApproval / bNeedsApproval in
  // `disabled` here — when approval is required, the primary action runs the
  // approval write (see `primaryAction` below), so the button must stay
  // clickable to let the user approve. Only balances / amounts / tx-in-flight
  // gate the button.
  const disabled =
    !ctx ||
    !isConnected ||
    !tokenB ||
    amountA === 0n ||
    amountBAdjusted === 0n ||
    !hasEnoughEtx ||
    !hasEnoughB ||
    isWorking;

  const actionLabel = (() => {
    if (!isConnected) return 'Connect wallet';
    if (!tokenB) return bSymbol === 'CUSTOM' ? 'Enter token B address' : 'Select token B';
    if (amountA === 0n || amountBAdjusted === 0n) return 'Enter amounts';
    if (!hasEnoughEtx) return 'Insufficient ETX';
    if (!hasEnoughB) return `Insufficient ${bSymbolLabel}`;
    if (etxNeedsApproval) return 'Approve ETX';
    if (bNeedsApproval) return `Approve ${bSymbolLabel}`;
    if (!pairExists) return 'Create pool & add liquidity';
    return 'Add liquidity';
  })();

  const primaryAction = etxNeedsApproval
    ? onApproveEtx
    : bNeedsApproval
      ? onApproveB
      : onAdd;

  if (!ctx) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-white/70">
        Switch your wallet to Etica Mainnet (chain 61803) to manage liquidity.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/80">Add liquidity</h2>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/50">
          ETX hub-and-spoke
        </span>
      </div>

      <TokenAmountInput
        label="Token A"
        tokenLabel="ETX"
        value={amountAStr}
        onChange={(v) => {
          setAmountAStr(sanitizeNumber(v));
          setLastEdited('A');
        }}
        balance={etxBalVal}
        decimals={18}
        locked
      />

      <div className="flex items-center justify-center text-white/40 text-sm">+</div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-white/60">
          <span>Token B</span>
          <select
            value={bSymbol}
            onChange={(e) => setBSymbol(e.target.value as BSymbol)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:border-emerald-500"
          >
            <option value="ETI">ETI</option>
            <option value="EGAZ">EGAZ</option>
            <option value="CUSTOM">Custom ERC20…</option>
          </select>
        </div>
        {bSymbol === 'CUSTOM' && (
          <input
            type="text"
            value={customB}
            onChange={(e) => setCustomB(e.target.value.trim())}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs outline-none focus:border-emerald-500"
            placeholder="0x… (ERC20 contract address)"
          />
        )}
        {customBIsStEtx && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            This token is not available in your region. Pick a different token.
          </div>
        )}
        <TokenAmountInput
          label=""
          tokenLabel={bSymbolLabel}
          value={amountBStr}
          onChange={(v) => {
            setAmountBStr(sanitizeNumber(v));
            setLastEdited('B');
          }}
          balance={bBalVal}
          decimals={bDecimals}
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/70 space-y-1">
        <InfoRow
          label="Pool"
          value={
            !tokenB
              ? '—'
              : pairExists
                ? `Exists · ${pairAddress.slice(0, 6)}…${pairAddress.slice(-4)}`
                : 'New pool (will be created)'
          }
        />
        {pairExists && reserves && (
          <InfoRow
            label="Pool price"
            value={
              reserves.rA === 0n || reserves.rB === 0n
                ? '—'
                : `1 ETX ≈ ${formatTruncated(
                    (reserves.rB * 10n ** 18n) / reserves.rA,
                    bDecimals,
                    6,
                  )} ${bSymbolLabel}`
            }
          />
        )}
        {!pairExists && amountA > 0n && amountBAdjusted > 0n && (
          <InfoRow
            label="Initial price"
            value={`1 ETX = ${formatTruncated(
              (amountBAdjusted * 10n ** 18n) / amountA,
              bDecimals,
              6,
            )} ${bSymbolLabel}`}
          />
        )}
        {!pairExists && (
          <InfoRow
            label="Pool-creation fee"
            value="10,000 ETX → treasury"
            accent="amber"
          />
        )}
      </div>

      <button
        onClick={() => void primaryAction()}
        disabled={disabled}
        className="w-full rounded-xl bg-brand-accent px-4 py-3 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isWorking ? 'Waiting for confirmation…' : actionLabel}
      </button>

      {submitError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {submitError}
        </div>
      )}
      {receipt.isSuccess && activeHash && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          Confirmed. Tx: <span className="font-mono">{shortHash(activeHash)}</span>
        </div>
      )}
    </div>
  );
}

function TokenAmountInput(props: {
  label: string;
  tokenLabel: string;
  value: string;
  onChange: (v: string) => void;
  balance: bigint;
  decimals: number;
  locked?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="flex items-center justify-between text-xs text-white/50">
        {props.label ? <span>{props.label}</span> : <span />}
        <span>
          Balance:{' '}
          <button
            type="button"
            onClick={() =>
              props.onChange(formatUnits(props.balance, props.decimals))
            }
            className="underline decoration-dotted underline-offset-2 hover:text-white"
          >
            {formatTruncated(props.balance, props.decimals, 6)}
          </button>
        </span>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className="w-full bg-transparent text-2xl outline-none placeholder:text-white/30"
        />
        <span
          className={
            'rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm font-medium' +
            (props.locked ? ' text-white/80' : ' text-white')
          }
        >
          {props.tokenLabel}
        </span>
      </div>
    </div>
  );
}

function InfoRow(props: { label: string; value: string; accent?: 'amber' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/50">{props.label}</span>
      <span className={props.accent === 'amber' ? 'text-amber-300' : 'text-white/80'}>
        {props.value}
      </span>
    </div>
  );
}

function formatTruncated(raw: bigint, decimals: number, maxFraction: number): string {
  const s = formatUnits(raw, decimals);
  const [intPart, fracPart] = s.split('.');
  if (!fracPart) return intPart;
  const short = fracPart.slice(0, maxFraction).replace(/0+$/, '');
  return short ? `${intPart}.${short}` : intPart;
}

function sanitizeNumber(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const [a, ...rest] = cleaned.split('.');
  return rest.length > 0 ? `${a}.${rest.join('')}` : a;
}

function shortHash(h: Hex): string {
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

function describeWriteError(err: unknown, fallback: string): string | undefined {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return undefined;
    return err.shortMessage ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
