'use client';

import { useEffect, useMemo, useState } from 'react';
import { AddNetworkButton } from '@/components/network/AddNetworkButton';
import {
  BaseError,
  UserRejectedRequestError,
  encodeFunctionData,
  formatUnits,
  getAddress,
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
  useSendTransaction,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  USDC_WARP_ROUTE,
  abis,
  eticaMainnet,
} from '@etica-hub/shared';
import { ConnectButton } from '@/components/ConnectButton';
import { usePairVolume24h } from '@/components/PairVolume24h';

export type WidgetPairKey = 'egaz' | 'eti';
type Tab = 'swap' | 'add';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const SLIPPAGE_BPS = 50n;
const USDC_DECIMALS = USDC_WARP_ROUTE.decimals;

interface PairDef {
  key: WidgetPairKey;
  /** Spoke token symbol (user-facing). */
  symbol: 'EGAZ' | 'ETI';
  /** ERC-20 address of the spoke token as the pool holds it. */
  token: Address;
  native: boolean;
  decimals: number;
}

function usePairDef(key: WidgetPairKey): PairDef {
  const d = DEPLOYMENTS[eticaMainnet.id];
  const e = EXTERNAL_ADDRESSES[eticaMainnet.id];
  return key === 'egaz'
    ? { key, symbol: 'EGAZ', token: d.wegaz, native: true, decimals: 18 }
    : { key, symbol: 'ETI', token: e.eti, native: false, decimals: 18 };
}

export function V2PoolWidget({
  pair: initialPair,
  referrer,
  theme,
}: {
  pair: WidgetPairKey;
  referrer: Address | string | null;
  theme: 'dark' | 'light';
}) {
  const d = DEPLOYMENTS[eticaMainnet.id];
  const usdc = USDC_WARP_ROUTE.syntheticToken;
  const [pairKey, setPairKey] = useState<WidgetPairKey>(initialPair);
  const spoke = usePairDef(pairKey);
  const router = d.v2Router;
  const factory = d.v2Factory;
  const deployed = router !== ZERO && factory !== ZERO;

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onEtica = chainId === eticaMainnet.id;
  // Host wallet, appended to swap calldata so the referral API can prove it on-chain.
  const ref: Address | null = referrer && isAddress(referrer, { strict: false }) ? getAddress(referrer) : null;
  const refSuffix = ref ? ref.slice(2).toLowerCase() : '';

  const [tab, setTab] = useState<Tab>('swap');

  const pairQ = useReadContract({
    abi: abis.factoryAbi,
    address: factory,
    functionName: 'getPair',
    args: [usdc, spoke.token],
    chainId: eticaMainnet.id,
    query: { enabled: deployed },
  });
  const pairAddress = ((pairQ.data as Address | undefined) ?? ZERO) as Address;
  const pairExists = pairAddress !== ZERO;

  const pairReads = useReadContracts({
    allowFailure: false,
    contracts: pairExists
      ? [
          { abi: abis.pairAbi, address: pairAddress, functionName: 'getReserves', chainId: eticaMainnet.id } as const,
          { abi: abis.pairAbi, address: pairAddress, functionName: 'token0', chainId: eticaMainnet.id } as const,
        ]
      : [],
    query: { enabled: pairExists, refetchInterval: 15_000 },
  });
  // Reserves ordered as (USDC.e, spoke).
  const reserves = useMemo<{ rU: bigint; rS: bigint } | null>(() => {
    const data = pairReads.data;
    if (!pairExists || !data || data.length < 2) return null;
    const [[r0, r1], token0] = data as [readonly [bigint, bigint, number], Address];
    return token0.toLowerCase() === usdc.toLowerCase() ? { rU: r0, rS: r1 } : { rU: r1, rS: r0 };
  }, [pairExists, pairReads.data, usdc]);
  const seeded = Boolean(reserves && reserves.rU > 0n && reserves.rS > 0n);
  const spotUsd = useMemo(() => {
    if (!reserves || !seeded) return null;
    return Number(formatUnits(reserves.rU, USDC_DECIMALS)) / Number(formatUnits(reserves.rS, spoke.decimals));
  }, [reserves, seeded, spoke.decimals]);
  const volume = usePairVolume24h(pairExists ? pairAddress : null);

  const nativeBal = useBalance({ address, chainId: eticaMainnet.id, query: { enabled: Boolean(address) } });
  const erc20Reads = useReadContracts({
    allowFailure: true,
    contracts: address
      ? [
          { abi: abis.erc20Abi, address: usdc, functionName: 'balanceOf', args: [address], chainId: eticaMainnet.id } as const,
          { abi: abis.erc20Abi, address: spoke.token, functionName: 'balanceOf', args: [address], chainId: eticaMainnet.id } as const,
          { abi: abis.erc20Abi, address: usdc, functionName: 'allowance', args: [address, router], chainId: eticaMainnet.id } as const,
          { abi: abis.erc20Abi, address: spoke.token, functionName: 'allowance', args: [address, router], chainId: eticaMainnet.id } as const,
        ]
      : [],
    query: { enabled: Boolean(address && deployed) },
  });
  const readBig = (i: number): bigint => {
    const r = erc20Reads.data?.[i];
    return r && r.status === 'success' ? (r.result as bigint) : 0n;
  };
  const usdcBal = readBig(0);
  const spokeBal = spoke.native ? (nativeBal.data?.value ?? 0n) : readBig(1);
  const usdcAllowance = readBig(2);
  const spokeAllowance = spoke.native ? MAX_UINT256 : readBig(3);

  // ---- Swap state ----
  const [sellUsdc, setSellUsdc] = useState(true);
  const [swapInStr, setSwapInStr] = useState('');
  const inDecimals = sellUsdc ? USDC_DECIMALS : spoke.decimals;
  const outDecimals = sellUsdc ? spoke.decimals : USDC_DECIMALS;
  const inSymbol = sellUsdc ? 'USDC.e' : spoke.symbol;
  const outSymbol = sellUsdc ? spoke.symbol : 'USDC.e';
  const swapIn = useMemo(() => {
    try {
      return swapInStr ? parseUnits(swapInStr, inDecimals) : 0n;
    } catch {
      return 0n;
    }
  }, [swapInStr, inDecimals]);
  const path = useMemo<Address[]>(
    () => (sellUsdc ? [usdc, spoke.token] : [spoke.token, usdc]),
    [sellUsdc, usdc, spoke.token],
  );
  const quote = useReadContract({
    abi: abis.routerAbi,
    address: router,
    functionName: 'getAmountsOut',
    args: swapIn > 0n ? [swapIn, path] : undefined,
    chainId: eticaMainnet.id,
    query: { enabled: deployed && seeded && swapIn > 0n, refetchInterval: 15_000 },
  });
  const swapOut = useMemo(() => {
    const data = quote.data as readonly bigint[] | undefined;
    return data && data.length >= 2 ? data[data.length - 1] : 0n;
  }, [quote.data]);
  const swapOutMin = (swapOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const priceImpactPct = useMemo(() => {
    if (!reserves || !seeded || swapIn === 0n || swapOut === 0n) return null;
    const rIn = sellUsdc ? reserves.rU : reserves.rS;
    const rOut = sellUsdc ? reserves.rS : reserves.rU;
    const spot = Number(formatUnits(rOut, outDecimals)) / Number(formatUnits(rIn, inDecimals));
    const exec = Number(formatUnits(swapOut, outDecimals)) / Number(formatUnits(swapIn, inDecimals));
    return Math.max(0, (1 - exec / spot) * 100);
  }, [reserves, seeded, swapIn, swapOut, sellUsdc, inDecimals, outDecimals]);
  const swapInBal = sellUsdc ? usdcBal : spokeBal;
  const swapInIsNative = !sellUsdc && spoke.native;
  const swapNeedsApproval =
    !swapInIsNative && swapIn > 0n && (sellUsdc ? usdcAllowance : spokeAllowance) < swapIn;

  // ---- Add-liquidity state ----
  const [addUsdcStr, setAddUsdcStr] = useState('');
  const [addSpokeStr, setAddSpokeStr] = useState('');
  const [lastEdited, setLastEdited] = useState<'U' | 'S'>('U');
  const addUsdc = useMemo(() => {
    try {
      return addUsdcStr ? parseUnits(addUsdcStr, USDC_DECIMALS) : 0n;
    } catch {
      return 0n;
    }
  }, [addUsdcStr]);
  const addSpoke = useMemo(() => {
    try {
      return addSpokeStr ? parseUnits(addSpokeStr, spoke.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [addSpokeStr, spoke.decimals]);
  useEffect(() => {
    if (!reserves || !seeded) return;
    if (lastEdited === 'U') {
      if (!addUsdcStr) return setAddSpokeStr('');
      try {
        const u = parseUnits(addUsdcStr, USDC_DECIMALS);
        setAddSpokeStr(formatUnits((u * reserves.rS) / reserves.rU, spoke.decimals));
      } catch {
        /* ignore */
      }
    } else {
      if (!addSpokeStr) return setAddUsdcStr('');
      try {
        const s = parseUnits(addSpokeStr, spoke.decimals);
        setAddUsdcStr(formatUnits((s * reserves.rU) / reserves.rS, USDC_DECIMALS));
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEdited, addUsdcStr, addSpokeStr, reserves?.rU, reserves?.rS, seeded]);
  const addUsdcNeedsApproval = addUsdc > 0n && usdcAllowance < addUsdc;
  const addSpokeNeedsApproval = !spoke.native && addSpoke > 0n && spokeAllowance < addSpoke;

  // ---- Writes ----
  const { writeContractAsync, data: txHash, isPending: isWritePending, reset: resetWrite } = useWriteContract();
  const { sendTransactionAsync, isPending: isSendPending, reset: resetSend } = useSendTransaction();
  const isPending = isWritePending || isSendPending;
  const [pendingHash, setPendingHash] = useState<Hex | undefined>();
  const [pendingKind, setPendingKind] = useState<'swap' | 'add' | 'approve' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const activeHash = pendingHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({ hash: activeHash, chainId: eticaMainnet.id, query: { enabled: Boolean(activeHash) } });
  const working = isPending || receipt.isLoading;

  useEffect(() => {
    if (!receipt.isSuccess || !activeHash) return;
    void Promise.all([nativeBal.refetch(), erc20Reads.refetch(), pairReads.refetch(), pairQ.refetch(), quote.refetch()]).catch(() => {});
    if (pendingKind === 'swap' && ref) {
      // Credit the host site: the API re-reads the receipt on-chain, so a bad
      // or replayed hash is simply ignored.
      void fetch('/api/v1/widget/referrals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx: activeHash, ref }),
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, activeHash]);

  async function run(kind: 'swap' | 'add' | 'approve', fn: () => Promise<Hex>, fallback: string) {
    setError(undefined);
    setPendingHash(undefined);
    setPendingKind(kind);
    resetWrite();
    resetSend();
    try {
      setPendingHash(await fn());
    } catch (err) {
      setError(describeWriteError(err, fallback));
    }
  }
  const approve = (token: Address, label: string) =>
    run(
      'approve',
      () =>
        writeContractAsync({
          abi: abis.erc20Abi,
          address: token,
          functionName: 'approve',
          args: [router, MAX_UINT256],
          chainId: eticaMainnet.id,
        }),
      `${label} approval failed`,
    );
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  function onSwap() {
    if (!address || swapIn === 0n || swapOutMin === 0n) return;
    void run(
      'swap',
      () => {
        const dl = deadline();
        const call = swapInIsNative
          ? encodeFunctionData({ abi: abis.routerAbi, functionName: 'swapExactEGAZForTokens', args: [swapOutMin, path, address, dl] })
          : sellUsdc && spoke.native
            ? encodeFunctionData({ abi: abis.routerAbi, functionName: 'swapExactTokensForEGAZ', args: [swapIn, swapOutMin, path, address, dl] })
            : encodeFunctionData({ abi: abis.routerAbi, functionName: 'swapExactTokensForTokens', args: [swapIn, swapOutMin, path, address, dl] });
        // Trailing calldata is ignored by the router; it tags the swap with the host wallet.
        return sendTransactionAsync({
          to: router,
          data: `${call}${refSuffix}` as Hex,
          value: swapInIsNative ? swapIn : undefined,
          chainId: eticaMainnet.id,
        });
      },
      'Swap failed',
    );
  }

  function onAdd() {
    if (!address || addUsdc === 0n || addSpoke === 0n) return;
    const minU = seeded ? (addUsdc * (10_000n - SLIPPAGE_BPS)) / 10_000n : addUsdc;
    const minS = seeded ? (addSpoke * (10_000n - SLIPPAGE_BPS)) / 10_000n : addSpoke;
    void run(
      'add',
      () =>
        spoke.native
          ? writeContractAsync({
              abi: abis.routerAbi,
              address: router,
              functionName: 'addLiquidityEGAZ',
              args: [usdc, addUsdc, minU, minS, address, deadline()],
              value: addSpoke,
              chainId: eticaMainnet.id,
            })
          : writeContractAsync({
              abi: abis.routerAbi,
              address: router,
              functionName: 'addLiquidity',
              args: [usdc, spoke.token, addUsdc, addSpoke, minU, minS, address, deadline()],
              chainId: eticaMainnet.id,
            }),
      'Add liquidity failed',
    );
  }

  const swapLabel = (() => {
    if (!isConnected) return 'Connect wallet';
    if (!onEtica) return 'Switch to Etica Mainnet';
    if (!seeded) return 'Pool has no liquidity yet';
    if (swapIn === 0n) return 'Enter an amount';
    if (swapInBal < swapIn) return `Insufficient ${inSymbol}`;
    if (swapNeedsApproval) return `Approve ${inSymbol}`;
    return `Swap ${inSymbol} → ${outSymbol}`;
  })();
  const swapDisabled =
    !isConnected || !onEtica || !seeded || swapIn === 0n || swapInBal < swapIn || working || (!swapNeedsApproval && swapOut === 0n);
  const swapAction = swapNeedsApproval ? () => void approve(sellUsdc ? usdc : spoke.token, inSymbol) : onSwap;

  const addLabel = (() => {
    if (!isConnected) return 'Connect wallet';
    if (!onEtica) return 'Switch to Etica Mainnet';
    if (addUsdc === 0n || addSpoke === 0n) return 'Enter amounts';
    if (usdcBal < addUsdc) return 'Insufficient USDC.e';
    if (spokeBal < addSpoke) return `Insufficient ${spoke.symbol}`;
    if (addUsdcNeedsApproval) return 'Approve USDC.e';
    if (addSpokeNeedsApproval) return `Approve ${spoke.symbol}`;
    return seeded ? 'Add liquidity' : 'Seed pool (sets the opening price)';
  })();
  const addDisabled =
    !isConnected || !onEtica || addUsdc === 0n || addSpoke === 0n || usdcBal < addUsdc || spokeBal < addSpoke || working;
  const addAction = addUsdcNeedsApproval
    ? () => void approve(usdc, 'USDC.e')
    : addSpokeNeedsApproval
      ? () => void approve(spoke.token, spoke.symbol)
      : onAdd;

  const light = theme === 'light';
  const shell = light ? 'bg-white text-neutral-900' : 'bg-[#0b0f14] text-white';
  const panel = light ? 'border-neutral-200 bg-neutral-50' : 'border-white/[0.08] bg-white/[0.03]';
  const muted = light ? 'text-neutral-500' : 'text-white/50';
  const input = light ? 'bg-white border-neutral-200' : 'bg-black/30 border-white/[0.08]';
  const tabCls = (t: Tab) =>
    `flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
      tab === t ? (light ? 'bg-neutral-900 text-white' : 'bg-white/15 text-white') : muted
    }`;

  if (!deployed) {
    return <div className={`min-h-screen p-4 text-sm ${shell}`}>Pool not deployed yet.</div>;
  }

  return (
    <div className={`min-h-screen p-3 sm:p-4 ${shell}`}>
      <div className="mx-auto max-w-md space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className={`text-[11px] uppercase tracking-wider ${muted}`}>EticaSwap pool · Etica mainnet</div>
            <div className="mt-1 flex gap-1">
              {(['egaz', 'eti'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    if (k === pairKey) return;
                    setPairKey(k);
                    setSwapInStr('');
                    setAddUsdcStr('');
                    setAddSpokeStr('');
                    setError(undefined);
                  }}
                  className={`rounded-lg px-2.5 py-1 text-sm font-semibold transition ${
                    pairKey === k ? (light ? 'bg-neutral-900 text-white' : 'bg-white/15 text-white') : muted
                  }`}
                >
                  {k === 'egaz' ? 'EGAZ' : 'ETI'}/USDC.e
                </button>
              ))}
            </div>
          </div>
          <ConnectButton />
        </div>

        <div className={`grid grid-cols-3 gap-2 rounded-xl border p-3 text-xs ${panel}`}>
          <Stat label="Price" value={spotUsd !== null ? `$${fmt(spotUsd, 6)}` : '—'} muted={muted} />
          <Stat
            label="Liquidity"
            value={reserves ? `${fmtUnits(reserves.rU, USDC_DECIMALS)} USDC.e · ${fmtUnits(reserves.rS, spoke.decimals)} ${spoke.symbol}` : '—'}
            muted={muted}
          />
          <Stat
            label="24h volume"
            value={
              volume.status === 'ready' && volume.data
                ? `${fmtUnits(BigInt(volume.data.token0.volume), volume.data.token0.decimals ?? 18)} ${volume.data.token0.symbol ?? ''} · ${volume.data.swapCount} swaps`
                : volume.status === 'loading'
                  ? '…'
                  : '—'
            }
            muted={muted}
          />
        </div>

        <div className={`flex gap-1 rounded-xl border p-1 ${panel}`}>
          <button type="button" className={tabCls('swap')} onClick={() => setTab('swap')}>
            Swap
          </button>
          <button type="button" className={tabCls('add')} onClick={() => setTab('add')}>
            Add liquidity
          </button>
        </div>

        {tab === 'swap' ? (
          <div className={`space-y-3 rounded-xl border p-3 ${panel}`}>
            <AmountRow
              label={`Sell ${inSymbol}`}
              value={swapInStr}
              onChange={(v) => setSwapInStr(sanitizeNumber(v))}
              balance={swapInBal}
              decimals={inDecimals}
              symbol={inSymbol}
              cls={input}
              muted={muted}
            />
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setSellUsdc((s) => !s);
                  setSwapInStr('');
                }}
                className={`rounded-full border px-3 py-1 text-xs ${panel}`}
                aria-label="Flip direction"
              >
                ⇅
              </button>
            </div>
            <div className={`rounded-lg border px-3 py-2 text-sm ${input}`}>
              <div className={`text-[11px] ${muted}`}>Receive {outSymbol} (est.)</div>
              <div className="font-mono">{swapOut > 0n ? fmtUnits(swapOut, outDecimals) : '0.0'}</div>
            </div>
            <div className={`space-y-0.5 text-[11px] ${muted}`}>
              <div className="flex justify-between">
                <span>Min. received (0.5% slippage)</span>
                <span className="font-mono">{swapOutMin > 0n ? fmtUnits(swapOutMin, outDecimals) : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span>Price impact</span>
                <span className={priceImpactPct !== null && priceImpactPct > 5 ? 'text-amber-400' : ''}>
                  {priceImpactPct !== null ? `${priceImpactPct.toFixed(2)}%` : '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Fee</span>
                <span>0.30%</span>
              </div>
            </div>
            <button
              type="button"
              onClick={swapAction}
              disabled={swapDisabled}
              className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {working ? 'Waiting for confirmation…' : swapLabel}
            </button>
          </div>
        ) : (
          <div className={`space-y-3 rounded-xl border p-3 ${panel}`}>
            <AmountRow
              label="USDC.e"
              value={addUsdcStr}
              onChange={(v) => {
                setAddUsdcStr(sanitizeNumber(v));
                setLastEdited('U');
              }}
              balance={usdcBal}
              decimals={USDC_DECIMALS}
              symbol="USDC.e"
              cls={input}
              muted={muted}
            />
            <AmountRow
              label={spoke.symbol}
              value={addSpokeStr}
              onChange={(v) => {
                setAddSpokeStr(sanitizeNumber(v));
                setLastEdited('S');
              }}
              balance={spokeBal}
              decimals={spoke.decimals}
              symbol={spoke.symbol}
              cls={input}
              muted={muted}
            />
            <div className={`text-[11px] ${muted}`}>
              {seeded
                ? `Deposits follow the pool ratio (1 ${spoke.symbol} = $${spotUsd !== null ? fmt(spotUsd, 6) : '—'}). You receive LP tokens and earn 0.25% of every swap.`
                : addUsdc > 0n && addSpoke > 0n
                  ? `Opening price: 1 ${spoke.symbol} = $${fmt(Number(formatUnits(addUsdc, USDC_DECIMALS)) / Number(formatUnits(addSpoke, spoke.decimals)), 6)}`
                  : 'The pool is empty: the first deposit sets the opening price.'}
            </div>
            <button
              type="button"
              onClick={addAction}
              disabled={addDisabled}
              className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {working ? 'Waiting for confirmation…' : addLabel}
            </button>
          </div>
        )}

        {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        {receipt.isSuccess && activeHash && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            Confirmed.{' '}
            <a href={`https://eticahub.com/explorer/tx/${activeHash}`} target="_blank" rel="noreferrer" className="font-mono underline">
              {activeHash.slice(0, 10)}…{activeHash.slice(-6)}
            </a>
          </div>
        )}

        <div className={`flex items-center justify-between text-[10px] ${muted}`}>
          <span className="font-mono">
            pair {pairExists ? `${pairAddress.slice(0, 6)}…${pairAddress.slice(-4)}` : '—'}
          </span>
          <span className="flex items-center gap-3">
            <AddNetworkButton className="hover:underline" compact />
            <a href="https://eticahub.com" target="_blank" rel="noreferrer" className="hover:underline">
              Powered by EticaSwap
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted: string }) {
  return (
    <div className="min-w-0">
      <div className={`text-[10px] uppercase tracking-wider ${muted}`}>{label}</div>
      <div className="truncate font-mono text-[11px]" title={value}>
        {value}
      </div>
    </div>
  );
}

function AmountRow(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  balance: bigint;
  decimals: number;
  symbol: string;
  cls: string;
  muted: string;
}) {
  return (
    <div className={`rounded-lg border p-3 ${props.cls}`}>
      <div className={`flex items-center justify-between text-[11px] ${props.muted}`}>
        <span>{props.label}</span>
        <button
          type="button"
          onClick={() => props.onChange(formatUnits(props.balance, props.decimals))}
          className="underline decoration-dotted underline-offset-2"
        >
          Balance {fmtUnits(props.balance, props.decimals)}
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className="w-full bg-transparent text-xl outline-none placeholder:opacity-40"
        />
        <span className="text-sm font-medium">{props.symbol}</span>
      </div>
    </div>
  );
}

function fmt(n: number, maxFraction: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFraction });
}

function fmtUnits(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(2);
  return fmt(n, n < 1 ? 6 : n < 1000 ? 4 : 2);
}

function sanitizeNumber(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const [a, ...rest] = cleaned.split('.');
  return rest.length > 0 ? `${a}.${rest.join('')}` : a;
}

function describeWriteError(err: unknown, fallback: string): string | undefined {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return undefined;
    return err.shortMessage ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
