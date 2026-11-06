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
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContracts,
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { DEPLOYMENTS, abis, eticaMainnet } from '@etica-hub/shared';
import { ConnectButton } from '@/components/ConnectButton';
import { usePairVolume24h } from '@/components/PairVolume24h';
import type { WidgetPool, WidgetToken } from '@/lib/widget/poolKeys';
import { burnOutput } from '@/lib/widget/lpMath';

type Tab = 'swap' | 'add' | 'remove';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;
const SLIPPAGE_BPS = 50n;
const kLastAbi = parseAbi(['function kLast() view returns (uint256)']);

function parse(str: string, decimals: number): bigint {
  try {
    return str ? parseUnits(str, decimals) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Swap / add / remove liquidity on any pool of the standalone V2 factory.
 * `pools` comes from the server (every pool on the factory); the widget reads
 * reserves and balances for the selected one. Tokens are generic: when either
 * side is EGAZ the router's *EGAZ functions and the native balance are used.
 */
export function V2PoolWidget({
  pools,
  initialPool,
  referrer,
  theme,
}: {
  pools: WidgetPool[];
  initialPool: Address | null;
  referrer: Address | string | null;
  theme: 'dark' | 'light';
}) {
  const d = DEPLOYMENTS[eticaMainnet.id];
  const router = d.v2Router;
  const factory = d.v2Factory;
  const deployed = router !== ZERO && factory !== ZERO;
  const [poolAddress, setPoolAddress] = useState<Address | null>(initialPool ?? pools[0]?.address ?? null);
  const pool = pools.find((p) => p.address === poolAddress) ?? pools[0] ?? null;
  const base: WidgetToken = pool?.base ?? { address: ZERO, symbol: '—', decimals: 18, native: false };
  const quote: WidgetToken = pool?.quote ?? { address: ZERO, symbol: '—', decimals: 18, native: false };
  const pairAddress: Address = pool?.address ?? ZERO;
  const pairExists = pairAddress !== ZERO;
  const quoteIsUsd = quote.symbol === 'USDC.e';

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onEtica = chainId === eticaMainnet.id;
  // Host wallet, appended to swap calldata so the referral API can prove it on-chain.
  const ref: Address | null = referrer && isAddress(referrer, { strict: false }) ? getAddress(referrer) : null;
  const refSuffix = ref ? ref.slice(2).toLowerCase() : '';

  const [tab, setTab] = useState<Tab>('swap');

  const pairReads = useReadContracts({
    allowFailure: false,
    contracts: pairExists
      ? [
          { abi: abis.pairAbi, address: pairAddress, functionName: 'getReserves', chainId: eticaMainnet.id } as const,
          { abi: abis.pairAbi, address: pairAddress, functionName: 'token0', chainId: eticaMainnet.id } as const,
          { abi: abis.erc20Abi, address: pairAddress, functionName: 'totalSupply', chainId: eticaMainnet.id } as const,
          { abi: kLastAbi, address: pairAddress, functionName: 'kLast', chainId: eticaMainnet.id } as const,
          { abi: abis.factoryAbi, address: factory, functionName: 'feeTo', chainId: eticaMainnet.id } as const,
        ]
      : [],
    query: { enabled: pairExists, refetchInterval: 15_000 },
  });
  // Reserves ordered as (base, quote); r0/r1 kept in pool order for the burn math.
  const reserves = useMemo<{ rB: bigint; rQ: bigint; r0: bigint; r1: bigint; baseIs0: boolean; lpSupply: bigint; kLast: bigint; feeOn: boolean } | null>(() => {
    const data = pairReads.data;
    if (!pairExists || !data || data.length < 5) return null;
    const [[r0, r1], token0, lpSupply, kLast, feeTo] = data as [readonly [bigint, bigint, number], Address, bigint, bigint, Address];
    const baseIs0 = token0.toLowerCase() === base.address.toLowerCase();
    return { rB: baseIs0 ? r0 : r1, rQ: baseIs0 ? r1 : r0, r0, r1, baseIs0, lpSupply, kLast, feeOn: feeTo !== ZERO };
  }, [pairExists, pairReads.data, base.address]);
  const seeded = Boolean(reserves && reserves.rB > 0n && reserves.rQ > 0n);
  const spot = useMemo(() => {
    if (!reserves || !seeded) return null;
    return Number(formatUnits(reserves.rQ, quote.decimals)) / Number(formatUnits(reserves.rB, base.decimals));
  }, [reserves, seeded, quote.decimals, base.decimals]);
  const priceStr = (p: number) => (quoteIsUsd ? `$${fmt(p, 6)}` : `${fmt(p, 6)} ${quote.symbol}`);
  const volume = usePairVolume24h(pairExists ? pairAddress : null);

  const nativeBal = useBalance({ address, chainId: eticaMainnet.id, query: { enabled: Boolean(address) } });
  const erc20Reads = useReadContracts({
    allowFailure: true,
    contracts:
      address && pairExists
        ? [
            { abi: abis.erc20Abi, address: base.address, functionName: 'balanceOf', args: [address], chainId: eticaMainnet.id } as const,
            { abi: abis.erc20Abi, address: quote.address, functionName: 'balanceOf', args: [address], chainId: eticaMainnet.id } as const,
            { abi: abis.erc20Abi, address: base.address, functionName: 'allowance', args: [address, router], chainId: eticaMainnet.id } as const,
            { abi: abis.erc20Abi, address: quote.address, functionName: 'allowance', args: [address, router], chainId: eticaMainnet.id } as const,
            { abi: abis.erc20Abi, address: pairAddress, functionName: 'balanceOf', args: [address], chainId: eticaMainnet.id } as const,
            { abi: abis.erc20Abi, address: pairAddress, functionName: 'allowance', args: [address, router], chainId: eticaMainnet.id } as const,
          ]
        : [],
    query: { enabled: Boolean(address && deployed && pairExists) },
  });
  const readBig = (i: number): bigint => {
    const r = erc20Reads.data?.[i];
    return r && r.status === 'success' ? (r.result as bigint) : 0n;
  };
  const native = nativeBal.data?.value ?? 0n;
  const baseBal = base.native ? native : readBig(0);
  const quoteBal = quote.native ? native : readBig(1);
  const baseAllowance = base.native ? MAX_UINT256 : readBig(2);
  const quoteAllowance = quote.native ? MAX_UINT256 : readBig(3);
  const lpBal = readBig(4);
  const lpAllowance = readBig(5);

  // ---- Swap state ----
  const [sellQuote, setSellQuote] = useState(true);
  const [swapInStr, setSwapInStr] = useState('');
  const tokIn = sellQuote ? quote : base;
  const tokOut = sellQuote ? base : quote;
  const swapIn = useMemo(() => parse(swapInStr, tokIn.decimals), [swapInStr, tokIn.decimals]);
  const path = useMemo<Address[]>(() => [tokIn.address, tokOut.address], [tokIn.address, tokOut.address]);
  const quoteQ = useReadContract({
    abi: abis.routerAbi,
    address: router,
    functionName: 'getAmountsOut',
    args: swapIn > 0n ? [swapIn, path] : undefined,
    chainId: eticaMainnet.id,
    query: { enabled: deployed && seeded && swapIn > 0n, refetchInterval: 15_000 },
  });
  const swapOut = useMemo(() => {
    const data = quoteQ.data as readonly bigint[] | undefined;
    return data && data.length >= 2 ? data[data.length - 1] : 0n;
  }, [quoteQ.data]);
  const swapOutMin = (swapOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const priceImpactPct = useMemo(() => {
    if (!reserves || !seeded || swapIn === 0n || swapOut === 0n) return null;
    const rIn = sellQuote ? reserves.rQ : reserves.rB;
    const rOut = sellQuote ? reserves.rB : reserves.rQ;
    const spotPx = Number(formatUnits(rOut, tokOut.decimals)) / Number(formatUnits(rIn, tokIn.decimals));
    const exec = Number(formatUnits(swapOut, tokOut.decimals)) / Number(formatUnits(swapIn, tokIn.decimals));
    return Math.max(0, (1 - exec / spotPx) * 100);
  }, [reserves, seeded, swapIn, swapOut, sellQuote, tokIn.decimals, tokOut.decimals]);
  const swapInBal = sellQuote ? quoteBal : baseBal;
  const swapNeedsApproval = !tokIn.native && swapIn > 0n && (sellQuote ? quoteAllowance : baseAllowance) < swapIn;

  // ---- Add-liquidity state ----
  const [addBaseStr, setAddBaseStr] = useState('');
  const [addQuoteStr, setAddQuoteStr] = useState('');
  const [lastEdited, setLastEdited] = useState<'B' | 'Q'>('Q');
  const addBase = useMemo(() => parse(addBaseStr, base.decimals), [addBaseStr, base.decimals]);
  const addQuote = useMemo(() => parse(addQuoteStr, quote.decimals), [addQuoteStr, quote.decimals]);
  useEffect(() => {
    if (!reserves || !seeded) return;
    if (lastEdited === 'Q') {
      if (!addQuoteStr) return setAddBaseStr('');
      const q = parse(addQuoteStr, quote.decimals);
      if (q > 0n) setAddBaseStr(formatUnits((q * reserves.rB) / reserves.rQ, base.decimals));
    } else {
      if (!addBaseStr) return setAddQuoteStr('');
      const b = parse(addBaseStr, base.decimals);
      if (b > 0n) setAddQuoteStr(formatUnits((b * reserves.rQ) / reserves.rB, quote.decimals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEdited, addBaseStr, addQuoteStr, reserves?.rB, reserves?.rQ, seeded]);
  const addBaseNeedsApproval = !base.native && addBase > 0n && baseAllowance < addBase;
  const addQuoteNeedsApproval = !quote.native && addQuote > 0n && quoteAllowance < addQuote;

  // ---- Remove-liquidity state ----
  const [removePct, setRemovePct] = useState(50);
  const removeLp = (lpBal * BigInt(removePct)) / 100n;
  // what the burn really returns: the pair mints the protocol's fee share first, which dilutes the supply
  const removeOut = useMemo(() => {
    if (!reserves || reserves.lpSupply === 0n || removeLp === 0n) return null;
    const { amount0, amount1 } = burnOutput(removeLp, reserves.r0, reserves.r1, reserves.lpSupply, reserves.kLast, reserves.feeOn);
    return reserves.baseIs0 ? { b: amount0, q: amount1 } : { b: amount1, q: amount0 };
  }, [reserves, removeLp]);
  const removeNeedsApproval = removeLp > 0n && lpAllowance < removeLp;

  // ---- Writes ----
  const { writeContractAsync, data: txHash, isPending: isWritePending, reset: resetWrite } = useWriteContract();
  const { sendTransactionAsync, isPending: isSendPending, reset: resetSend } = useSendTransaction();
  const isPending = isWritePending || isSendPending;
  const [pendingHash, setPendingHash] = useState<Hex | undefined>();
  const [pendingKind, setPendingKind] = useState<'swap' | 'add' | 'remove' | 'approve' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const activeHash = pendingHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({ hash: activeHash, chainId: eticaMainnet.id, query: { enabled: Boolean(activeHash) } });
  const working = isPending || receipt.isLoading;

  useEffect(() => {
    if (!receipt.isSuccess || !activeHash) return;
    void Promise.all([nativeBal.refetch(), erc20Reads.refetch(), pairReads.refetch(), quoteQ.refetch()]).catch(() => {});
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

  async function run(kind: 'swap' | 'add' | 'remove' | 'approve', fn: () => Promise<Hex>, fallback: string) {
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
        const call = tokIn.native
          ? encodeFunctionData({ abi: abis.routerAbi, functionName: 'swapExactEGAZForTokens', args: [swapOutMin, path, address, dl] })
          : tokOut.native
            ? encodeFunctionData({ abi: abis.routerAbi, functionName: 'swapExactTokensForEGAZ', args: [swapIn, swapOutMin, path, address, dl] })
            : encodeFunctionData({ abi: abis.routerAbi, functionName: 'swapExactTokensForTokens', args: [swapIn, swapOutMin, path, address, dl] });
        // Trailing calldata is ignored by the router; it tags the swap with the host wallet.
        return sendTransactionAsync({
          to: router,
          data: `${call}${refSuffix}` as Hex,
          value: tokIn.native ? swapIn : undefined,
          chainId: eticaMainnet.id,
        });
      },
      'Swap failed',
    );
  }

  function onAdd() {
    if (!address || addBase === 0n || addQuote === 0n) return;
    const minB = seeded ? (addBase * (10_000n - SLIPPAGE_BPS)) / 10_000n : addBase;
    const minQ = seeded ? (addQuote * (10_000n - SLIPPAGE_BPS)) / 10_000n : addQuote;
    // the router's EGAZ variants take the ERC-20 side as `token` and EGAZ as msg.value
    const nativeSide = base.native ? 'B' : quote.native ? 'Q' : null;
    void run(
      'add',
      () =>
        nativeSide
          ? writeContractAsync({
              abi: abis.routerAbi,
              address: router,
              functionName: 'addLiquidityEGAZ',
              args:
                nativeSide === 'B'
                  ? [quote.address, addQuote, minQ, minB, address, deadline()]
                  : [base.address, addBase, minB, minQ, address, deadline()],
              value: nativeSide === 'B' ? addBase : addQuote,
              chainId: eticaMainnet.id,
            })
          : writeContractAsync({
              abi: abis.routerAbi,
              address: router,
              functionName: 'addLiquidity',
              args: [base.address, quote.address, addBase, addQuote, minB, minQ, address, deadline()],
              chainId: eticaMainnet.id,
            }),
      'Add liquidity failed',
    );
  }

  function onRemove() {
    if (!address || removeLp === 0n || !removeOut) return;
    const minB = (removeOut.b * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const minQ = (removeOut.q * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const nativeSide = base.native ? 'B' : quote.native ? 'Q' : null;
    void run(
      'remove',
      () =>
        nativeSide
          ? writeContractAsync({
              abi: abis.routerAbi,
              address: router,
              functionName: 'removeLiquidityEGAZ',
              args:
                nativeSide === 'B'
                  ? [quote.address, removeLp, minQ, minB, address, deadline()]
                  : [base.address, removeLp, minB, minQ, address, deadline()],
              chainId: eticaMainnet.id,
            })
          : writeContractAsync({
              abi: abis.routerAbi,
              address: router,
              functionName: 'removeLiquidity',
              args: [base.address, quote.address, removeLp, minB, minQ, address, deadline()],
              chainId: eticaMainnet.id,
            }),
      'Remove liquidity failed',
    );
  }

  const swapLabel = (() => {
    if (!isConnected) return 'Connect wallet';
    if (!onEtica) return 'Switch to Etica Mainnet';
    if (!seeded) return 'Pool has no liquidity yet';
    if (swapIn === 0n) return 'Enter an amount';
    if (swapInBal < swapIn) return `Insufficient ${tokIn.symbol}`;
    if (swapNeedsApproval) return `Approve ${tokIn.symbol}`;
    return `Swap ${tokIn.symbol} → ${tokOut.symbol}`;
  })();
  const swapDisabled =
    !isConnected || !onEtica || !seeded || swapIn === 0n || swapInBal < swapIn || working || (!swapNeedsApproval && swapOut === 0n);
  const swapAction = swapNeedsApproval ? () => void approve(tokIn.address, tokIn.symbol) : onSwap;

  const addLabel = (() => {
    if (!isConnected) return 'Connect wallet';
    if (!onEtica) return 'Switch to Etica Mainnet';
    if (addBase === 0n || addQuote === 0n) return 'Enter amounts';
    if (quoteBal < addQuote) return `Insufficient ${quote.symbol}`;
    if (baseBal < addBase) return `Insufficient ${base.symbol}`;
    if (addQuoteNeedsApproval) return `Approve ${quote.symbol}`;
    if (addBaseNeedsApproval) return `Approve ${base.symbol}`;
    return seeded ? 'Add liquidity' : 'Seed pool (sets the opening price)';
  })();
  const addDisabled =
    !isConnected || !onEtica || addBase === 0n || addQuote === 0n || quoteBal < addQuote || baseBal < addBase || working;
  const addAction = addQuoteNeedsApproval
    ? () => void approve(quote.address, quote.symbol)
    : addBaseNeedsApproval
      ? () => void approve(base.address, base.symbol)
      : onAdd;

  const removeLabel = (() => {
    if (!isConnected) return 'Connect wallet';
    if (!onEtica) return 'Switch to Etica Mainnet';
    if (lpBal === 0n) return 'No LP tokens in this pool';
    if (removeLp === 0n) return 'Choose an amount';
    if (removeNeedsApproval) return 'Approve LP tokens';
    return `Remove ${removePct}%`;
  })();
  const removeDisabled = !isConnected || !onEtica || removeLp === 0n || working;
  const removeAction = removeNeedsApproval ? () => void approve(pairAddress, 'LP') : onRemove;

  const light = theme === 'light';
  const shell = light ? 'bg-white text-neutral-900' : 'bg-[#0b0f14] text-white';
  const panel = light ? 'border-neutral-200 bg-neutral-50' : 'border-white/[0.08] bg-white/[0.03]';
  const muted = light ? 'text-neutral-500' : 'text-white/50';
  const input = light ? 'bg-white border-neutral-200' : 'bg-black/30 border-white/[0.08]';
  const tabCls = (t: Tab) =>
    `flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
      tab === t ? (light ? 'bg-neutral-900 text-white' : 'bg-white/15 text-white') : muted
    }`;
  const primaryBtn =
    'w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';

  if (!deployed) {
    return <div className={`min-h-screen p-4 text-sm ${shell}`}>Pool not deployed yet.</div>;
  }
  if (!pool) {
    return <div className={`min-h-screen p-4 text-sm ${shell}`}>Pools are unavailable right now; reload in a minute.</div>;
  }

  function switchPool(next: Address) {
    if (next === poolAddress) return;
    setPoolAddress(next);
    setSwapInStr('');
    setAddBaseStr('');
    setAddQuoteStr('');
    setError(undefined);
    setPendingHash(undefined);
  }

  return (
    <div className={`min-h-screen p-3 sm:p-4 ${shell}`}>
      <div className="mx-auto max-w-md space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className={`text-[11px] uppercase tracking-wider ${muted}`}>EticaSwap pool · Etica mainnet</div>
            <select
              aria-label="Pool"
              value={pool.address}
              onChange={(e) => switchPool(e.target.value as Address)}
              className={`mt-1 max-w-full rounded-lg border px-2.5 py-1 text-sm font-semibold ${input}`}
            >
              {pools.map((p) => (
                <option key={p.address} value={p.address}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <ConnectButton />
        </div>

        <div className={`grid grid-cols-3 gap-2 rounded-xl border p-3 text-xs ${panel}`}>
          <Stat label={`1 ${base.symbol}`} value={spot !== null ? priceStr(spot) : '—'} muted={muted} />
          <Stat
            label="Liquidity"
            value={reserves ? `${fmtUnits(reserves.rB, base.decimals)} ${base.symbol} · ${fmtUnits(reserves.rQ, quote.decimals)} ${quote.symbol}` : '—'}
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
          <button type="button" className={tabCls('remove')} onClick={() => setTab('remove')}>
            Remove
          </button>
        </div>

        {tab === 'swap' && (
          <div className={`space-y-3 rounded-xl border p-3 ${panel}`}>
            <AmountRow
              label={`Sell ${tokIn.symbol}`}
              value={swapInStr}
              onChange={(v) => setSwapInStr(sanitizeNumber(v))}
              balance={swapInBal}
              decimals={tokIn.decimals}
              symbol={tokIn.symbol}
              cls={input}
              muted={muted}
            />
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setSellQuote((s) => !s);
                  setSwapInStr('');
                }}
                className={`rounded-full border px-3 py-1 text-xs ${panel}`}
                aria-label="Flip direction"
              >
                ⇅
              </button>
            </div>
            <div className={`rounded-lg border px-3 py-2 text-sm ${input}`}>
              <div className={`text-[11px] ${muted}`}>Receive {tokOut.symbol} (est.)</div>
              <div className="font-mono">{swapOut > 0n ? fmtUnits(swapOut, tokOut.decimals) : '0.0'}</div>
            </div>
            <div className={`space-y-0.5 text-[11px] ${muted}`}>
              <div className="flex justify-between">
                <span>Min. received (0.5% slippage)</span>
                <span className="font-mono">{swapOutMin > 0n ? fmtUnits(swapOutMin, tokOut.decimals) : '—'}</span>
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
            <button type="button" onClick={swapAction} disabled={swapDisabled} className={primaryBtn}>
              {working ? 'Waiting for confirmation…' : swapLabel}
            </button>
          </div>
        )}

        {tab === 'add' && (
          <div className={`space-y-3 rounded-xl border p-3 ${panel}`}>
            <AmountRow
              label={quote.symbol}
              value={addQuoteStr}
              onChange={(v) => {
                setAddQuoteStr(sanitizeNumber(v));
                setLastEdited('Q');
              }}
              balance={quoteBal}
              decimals={quote.decimals}
              symbol={quote.symbol}
              cls={input}
              muted={muted}
            />
            <AmountRow
              label={base.symbol}
              value={addBaseStr}
              onChange={(v) => {
                setAddBaseStr(sanitizeNumber(v));
                setLastEdited('B');
              }}
              balance={baseBal}
              decimals={base.decimals}
              symbol={base.symbol}
              cls={input}
              muted={muted}
            />
            <div className={`text-[11px] ${muted}`}>
              {seeded
                ? `Deposits follow the pool ratio (1 ${base.symbol} = ${spot !== null ? priceStr(spot) : '—'}). You receive LP tokens and earn 0.25% of every swap.`
                : addBase > 0n && addQuote > 0n
                  ? `Opening price: 1 ${base.symbol} = ${priceStr(Number(formatUnits(addQuote, quote.decimals)) / Number(formatUnits(addBase, base.decimals)))}`
                  : 'The pool is empty: the first deposit sets the opening price.'}
            </div>
            <button type="button" onClick={addAction} disabled={addDisabled} className={primaryBtn}>
              {working ? 'Waiting for confirmation…' : addLabel}
            </button>
          </div>
        )}

        {tab === 'remove' && (
          <div className={`space-y-3 rounded-xl border p-3 ${panel}`}>
            <div className={`flex justify-between text-[11px] ${muted}`}>
              <span>Your LP tokens</span>
              <span className="font-mono">{fmtUnits(lpBal, 18)}</span>
            </div>
            <div className="flex gap-1">
              {[25, 50, 75, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setRemovePct(p)}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${removePct === p ? (light ? 'bg-neutral-900 text-white' : 'bg-white/15 text-white') : `${input} ${muted}`}`}
                >
                  {p}%
                </button>
              ))}
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={removePct}
              onChange={(e) => setRemovePct(Number(e.target.value))}
              className="w-full accent-emerald-500"
              aria-label="Share of your position to remove"
            />
            <div className={`rounded-lg border px-3 py-2 text-sm ${input}`}>
              <div className={`text-[11px] ${muted}`}>You receive (est.)</div>
              <div className="font-mono">
                {removeOut ? `${fmtUnits(removeOut.b, base.decimals)} ${base.symbol} + ${fmtUnits(removeOut.q, quote.decimals)} ${quote.symbol}` : '—'}
              </div>
            </div>
            <button type="button" onClick={removeAction} disabled={removeDisabled} className={primaryBtn}>
              {working ? 'Waiting for confirmation…' : removeLabel}
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
            pool {pairAddress.slice(0, 6)}…{pairAddress.slice(-4)}
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
