'use client';

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
import { eticaMainnet, supportedChains } from '@etica-hub/shared/chains';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';

type TokenSymbol = 'EGAZ' | 'ETI' | 'ETX' | 'stETX';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.50%

type SwapCtx = {
  chainId: number;
  router: Address;
  factory: Address;
  wegaz: Address;
  eti: Address;
  etx: Address;
  // Zero address on chains where the liquid-staking vault is not deployed
  // yet; the token picker hides the stETX option in that case.
  stetx: Address;
};

function useCtx(): SwapCtx | null {
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

function tokenAddress(ctx: SwapCtx, s: TokenSymbol): Address {
  if (s === 'EGAZ') return ctx.wegaz;
  if (s === 'ETI') return ctx.eti;
  if (s === 'stETX') return ctx.stetx;
  return ctx.etx;
}

/**
 * Hub-and-spoke routing: all swaps go through ETX. On-wire the ERC20
 * address list is WEGAZ (never the native EGAZ literal), so the router
 * knows where the native wrap/unwrap happens. stETX lives on the same
 * hub — stETX <-> {EGAZ,ETI} routes hop through the stETX/ETX pair then
 * through the ETX/{WEGAZ,ETI} pair.
 */
function buildPath(ctx: SwapCtx, from: TokenSymbol, to: TokenSymbol): Address[] | null {
  if (from === to) return null;
  // If ETX is one of the endpoints, direct 2-token path.
  if (from === 'ETX' || to === 'ETX') return [tokenAddress(ctx, from), tokenAddress(ctx, to)];
  // Otherwise hub through ETX.
  return [tokenAddress(ctx, from), ctx.etx, tokenAddress(ctx, to)];
}

export function SwapCard() {
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const dappChainId = useChainId();
  const ctx = useCtx();
  const { switchChain, isPending: isSwitchingChain, error: switchChainError } =
    useSwitchChain();
  // Wallet's actual reported chain may drift from wagmi's `useChainId()`
  // (which feeds `useCtx`) — e.g. when the user has Etica selected as the
  // dapp's chain but their wallet is connected to Ethereum mainnet. We use
  // the wallet-reported chain to gate the action button so the user gets a
  // clear "Switch network" prompt instead of a confusing wallet error when
  // viem tries to auto-switch mid-tx. We compare against the dapp's active
  // chain (not a hardcoded mainnet id) so the gate also works when running
  // against the local anvil fork.
  const onWrongNetwork =
    isConnected && walletChainId !== undefined && walletChainId !== dappChainId;
  const dappChain = supportedChains.find((c) => c.id === dappChainId);
  const dappChainName = dappChain?.name ?? 'Etica Mainnet';
  const [fromSymbol, setFromSymbol] = useState<TokenSymbol>('EGAZ');
  const [toSymbol, setToSymbol] = useState<TokenSymbol>('ETX');
  const [amountInStr, setAmountInStr] = useState('');

  const amountIn = useMemo(() => {
    if (!amountInStr) return 0n;
    try {
      return parseUnits(amountInStr, 18);
    } catch {
      return 0n;
    }
  }, [amountInStr]);

  const fromIsNative = fromSymbol === 'EGAZ';
  const toIsNative = toSymbol === 'EGAZ';

  const inputTokenAddr = useMemo<Address | null>(() => {
    if (!ctx) return null;
    if (fromSymbol === 'EGAZ') return null; // native — no ERC20 approval
    return tokenAddress(ctx, fromSymbol);
  }, [ctx, fromSymbol]);

  // Balances
  const nativeBal = useBalance({
    address,
    query: { enabled: Boolean(address && ctx) },
  });
  const etiBal = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.eti,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && ctx) },
  });
  const etxBal = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.etx,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && ctx) },
  });
  const stetxBal = useReadContract({
    abi: abis.erc20Abi,
    address: ctx?.stetx,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address && ctx && ctx.stetx !== ZERO),
    },
  });

  function balFor(symbol: TokenSymbol): bigint {
    if (symbol === 'EGAZ') return nativeBal.data?.value ?? 0n;
    if (symbol === 'ETI') return (etiBal.data as bigint | undefined) ?? 0n;
    if (symbol === 'stETX') return (stetxBal.data as bigint | undefined) ?? 0n;
    return (etxBal.data as bigint | undefined) ?? 0n;
  }

  // Allowance of input token -> router (only if non-native input)
  const allowance = useReadContract({
    abi: abis.erc20Abi,
    address: inputTokenAddr ?? undefined,
    functionName: 'allowance',
    args: address && ctx && inputTokenAddr ? [address, ctx.router] : undefined,
    query: { enabled: Boolean(address && ctx && inputTokenAddr) },
  });

  const path = useMemo<Address[] | null>(
    () => (ctx ? buildPath(ctx, fromSymbol, toSymbol) : null),
    [ctx, fromSymbol, toSymbol],
  );

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

  const fromBal = balFor(fromSymbol);
  const toBal = balFor(toSymbol);
  const hasEnoughBalance = fromBal >= amountIn;
  const needsApproval =
    !fromIsNative &&
    amountIn > 0n &&
    ((allowance.data as bigint | undefined) ?? 0n) < amountIn;

  const { writeContractAsync, data: txHash, isPending: isTxPending, reset: resetWrite } =
    useWriteContract();
  const [pendingTxHash, setPendingTxHash] = useState<Hex | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const activeHash = pendingTxHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({
    hash: activeHash,
    query: { enabled: Boolean(activeHash) },
  });

  async function onApprove() {
    if (!ctx || !address || !inputTokenAddr) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: inputTokenAddr,
        functionName: 'approve',
        args: [ctx.router, MAX_UINT256],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Approval failed'));
    }
  }

  async function onSwap() {
    if (!ctx || !address || !path || amountIn === 0n) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

    try {
      let hash: Hex;
      if (fromIsNative) {
        hash = await writeContractAsync({
          abi: abis.routerAbi,
          address: ctx.router,
          functionName: 'swapExactEGAZForTokens',
          args: [amountOutMin, path, address, deadline],
          value: amountIn,
        });
      } else if (toIsNative) {
        hash = await writeContractAsync({
          abi: abis.routerAbi,
          address: ctx.router,
          functionName: 'swapExactTokensForEGAZ',
          args: [amountIn, amountOutMin, path, address, deadline],
        });
      } else {
        hash = await writeContractAsync({
          abi: abis.routerAbi,
          address: ctx.router,
          functionName: 'swapExactTokensForTokens',
          args: [amountIn, amountOutMin, path, address, deadline],
        });
      }
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Swap failed'));
    }
  }

  // Refresh reads after a confirmed tx.
  useEffect(() => {
    if (!receipt.isSuccess) return;
    void Promise.all([
      nativeBal.refetch(),
      etiBal.refetch(),
      etxBal.refetch(),
      stetxBal.refetch(),
      allowance.refetch(),
      quote.refetch(),
    ]).catch(() => {
      // best-effort
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, activeHash]);

  function onFlip() {
    setFromSymbol(toSymbol);
    setToSymbol(fromSymbol);
    setAmountInStr('');
    setPendingTxHash(undefined);
    setSubmitError(undefined);
    resetWrite();
  }

  function onChangeFrom(next: TokenSymbol) {
    if (next === toSymbol) {
      // swap the pair so we never land on from == to
      setToSymbol(fromSymbol);
    }
    setFromSymbol(next);
    setAmountInStr('');
    setPendingTxHash(undefined);
    setSubmitError(undefined);
    resetWrite();
  }
  function onChangeTo(next: TokenSymbol) {
    if (next === fromSymbol) {
      setFromSymbol(toSymbol);
    }
    setToSymbol(next);
    setPendingTxHash(undefined);
    setSubmitError(undefined);
    resetWrite();
  }

  const priceImpactText = usePriceImpact(ctx, path, amountIn, amountOut);
  const routeText = describePath(path, ctx);
  const pickerOptions = tokenOptions(ctx);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/70">Swap</h2>
        <span className="text-xs text-white/40">v2 · 0.30% fee · ETX hub</span>
      </div>

      <div className="mt-4 space-y-2">
        <TokenInput
          label="From"
          symbol={fromSymbol}
          options={pickerOptions}
          onChangeSymbol={onChangeFrom}
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
          symbol={toSymbol}
          options={pickerOptions}
          onChangeSymbol={onChangeTo}
          balance={toBal}
          amount={amountOut === 0n ? '' : formatUnits(amountOut, 18)}
          editable={false}
        />
      </div>

      <dl className="mt-3 space-y-1 text-xs text-white/50">
        <Row k="Route">{routeText}</Row>
        <Row k="Min received">
          {amountOutMin === 0n
            ? '—'
            : `${truncate(formatUnits(amountOutMin, 18), 8)} ${toSymbol}`}
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
        approveSymbol={fromSymbol}
        onApprove={onApprove}
        onSwap={onSwap}
        onWrongNetwork={onWrongNetwork}
        isSwitchingChain={isSwitchingChain}
        onSwitchChain={() => switchChain({ chainId: dappChainId })}
        dappChainName={dappChainName}
      />

      {onWrongNetwork && switchChainError && dappChainId === eticaMainnet.id && (
        <p className="mt-3 break-words text-center text-xs text-rose-400">
          Couldn&rsquo;t switch your wallet to Etica Mainnet. Add the network
          manually: chain id <span className="font-mono">61803</span>, RPC{' '}
          <span className="font-mono">https://eticamainnet.eticascan.org</span>,
          currency symbol <span className="font-mono">EGAZ</span>.
        </p>
      )}
      {onWrongNetwork && switchChainError && dappChainId !== eticaMainnet.id && (
        <p className="mt-3 break-words text-center text-xs text-rose-400">
          Couldn&rsquo;t switch your wallet to {dappChainName}. Approve the
          network switch in your wallet, or add the chain manually.
        </p>
      )}

      {activeHash && receipt.isSuccess && (
        <p className="mt-3 break-all text-center text-xs text-emerald-400">
          Confirmed · tx {activeHash.slice(0, 10)}…{activeHash.slice(-8)}
        </p>
      )}
      {activeHash && receipt.isError && (
        <p className="mt-3 text-center text-xs text-rose-400">Transaction reverted.</p>
      )}
      {submitError && (
        <p className="mt-3 break-words text-center text-xs text-rose-400">{submitError}</p>
      )}
    </div>
  );
}

function describePath(path: Address[] | null, ctx: SwapCtx | null): string {
  if (!path || !ctx) return '—';
  const lookup = (a: Address): TokenSymbol => {
    const low = a.toLowerCase();
    if (low === ctx.wegaz.toLowerCase()) return 'EGAZ';
    if (low === ctx.eti.toLowerCase()) return 'ETI';
    if (ctx.stetx !== ZERO && low === ctx.stetx.toLowerCase()) return 'stETX';
    return 'ETX';
  };
  return path.map(lookup).join(' → ');
}

const BASE_TOKEN_OPTIONS: TokenSymbol[] = ['EGAZ', 'ETI', 'ETX'];

function tokenOptions(ctx: SwapCtx | null): TokenSymbol[] {
  if (!ctx || ctx.stetx === ZERO) return BASE_TOKEN_OPTIONS;
  return [...BASE_TOKEN_OPTIONS, 'stETX'];
}

function TokenInput(props: {
  label: string;
  symbol: TokenSymbol;
  options: readonly TokenSymbol[];
  onChangeSymbol?: (s: TokenSymbol) => void;
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
        {props.onChangeSymbol ? (
          <select
            value={props.symbol}
            onChange={(e) => props.onChangeSymbol?.(e.target.value as TokenSymbol)}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm"
            aria-label={`${props.label} token`}
          >
            {props.options.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
            {props.symbol}
          </span>
        )}
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
  ctx: SwapCtx | null;
  amountIn: bigint;
  amountOut: bigint;
  hasEnoughBalance: boolean;
  needsApproval: boolean;
  isTxPending: boolean;
  approveSymbol: TokenSymbol;
  onApprove: () => Promise<void>;
  onSwap: () => Promise<void>;
  onWrongNetwork: boolean;
  isSwitchingChain: boolean;
  onSwitchChain: () => void;
  dappChainName: string;
}) {
  const base =
    'mt-4 w-full rounded-xl py-3 font-medium disabled:opacity-50 disabled:cursor-not-allowed';
  const active = 'bg-brand-accent text-brand-ink hover:opacity-90';
  const warn = 'bg-amber-400 text-black hover:bg-amber-300';
  const subdued = 'bg-white/10 text-white/60';

  if (!props.isConnected) {
    return (
      <button disabled className={`${base} ${subdued}`}>
        Connect wallet to continue
      </button>
    );
  }
  if (props.onWrongNetwork) {
    return (
      <button
        onClick={props.onSwitchChain}
        disabled={props.isSwitchingChain}
        className={`${base} ${warn}`}
      >
        {props.isSwitchingChain
          ? 'Switching…'
          : `Switch to ${props.dappChainName}`}
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
        {props.isTxPending ? 'Approving…' : `Approve ${props.approveSymbol}`}
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
  ctx: SwapCtx | null,
  path: Address[] | null,
  amountIn: bigint,
  amountOut: bigint,
): string | null {
  // Read reserves on every consecutive pair of the path. For a 2-hop swap we
  // multiply mid-prices to get end-to-end spot price, then compare to the
  // realized execution price.
  const pairQueries = useReadContracts({
    contracts:
      ctx && path && amountIn > 0n
        ? path.slice(0, -1).map((_, i) => ({
            abi: abis.factoryAbi,
            address: ctx.factory,
            functionName: 'getPair' as const,
            args: [path[i], path[i + 1]] as const,
          }))
        : [],
    query: { enabled: Boolean(ctx && path && amountIn > 0n) },
  });

  const pairs = useMemo<Array<Address | null>>(() => {
    if (!pairQueries.data) return [];
    return pairQueries.data.map((r) => {
      const a = r.result as Address | undefined;
      return a && a !== ZERO ? a : null;
    });
  }, [pairQueries.data]);

  const reserveQueries = useReadContracts({
    contracts: pairs.flatMap((p) =>
      p
        ? [
            { abi: abis.pairAbi, address: p, functionName: 'getReserves' as const },
            { abi: abis.pairAbi, address: p, functionName: 'token0' as const },
          ]
        : [],
    ),
    query: { enabled: pairs.length > 0 && pairs.every((p) => p !== null) },
  });

  return useMemo(() => {
    if (!ctx || !path || amountIn === 0n || amountOut === 0n) return null;
    if (pairs.length === 0 || pairs.some((p) => p === null)) return null;
    const rows = reserveQueries.data;
    if (!rows) return null;

    // Compute spot output by walking each hop.
    let spotAmount = amountIn;
    for (let i = 0; i < pairs.length; i++) {
      const reservesRow = rows[i * 2];
      const token0Row = rows[i * 2 + 1];
      if (!reservesRow || !token0Row) return null;
      const reserves = reservesRow.result as
        | readonly [bigint, bigint, number]
        | undefined;
      const token0 = token0Row.result as Address | undefined;
      if (!reserves || !token0) return null;
      const inputIsToken0 = token0.toLowerCase() === path[i].toLowerCase();
      const [r0, r1] = reserves;
      const rIn = inputIsToken0 ? r0 : r1;
      const rOut = inputIsToken0 ? r1 : r0;
      if (rIn === 0n || rOut === 0n) return null;
      // spot price = rOut / rIn; spotOut = spotAmount * rOut / rIn
      spotAmount = (spotAmount * rOut) / rIn;
    }
    if (spotAmount === 0n) return null;
    const diff = spotAmount > amountOut ? spotAmount - amountOut : 0n;
    // basis points: diff / spot * 10_000
    const bps = Number((diff * 10_000n) / spotAmount);
    if (bps < 1) return '< 0.01%';
    return `${(bps / 100).toFixed(2)}%`;
  }, [ctx, path, amountIn, amountOut, pairs, reserveQueries.data]);
}

function truncate(s: string, maxFraction: number): string {
  const [intPart, fracPart] = s.split('.');
  if (!fracPart) return intPart;
  const short = fracPart.slice(0, maxFraction).replace(/0+$/, '');
  return short ? `${intPart}.${short}` : intPart;
}

function sanitizeNumber(raw: string): string {
  // allow digits and one dot
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const [a, ...rest] = cleaned.split('.');
  return rest.length > 0 ? `${a}.${rest.join('')}` : a;
}

function describeWriteError(err: unknown, fallback: string): string | undefined {
  // viem wraps wallet rejections in TransactionExecutionError; walk the chain.
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return undefined;
    return err.shortMessage ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
