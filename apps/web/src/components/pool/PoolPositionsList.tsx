'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  formatUnits,
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
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.50%

type Ctx = {
  chainId: number;
  router: Address;
  factory: Address;
  wegaz: Address;
  etx: Address;
  etxFarms: Address;
};

function useCtx(): Ctx | null {
  const chainId = useChainId();
  return useMemo(() => {
    if (!isSupportedChainId(chainId)) return null;
    const d = DEPLOYMENTS[chainId];
    if (d.swapRouter === ZERO || d.etx === ZERO || d.wegaz === ZERO) return null;
    return {
      chainId,
      router: d.swapRouter,
      factory: d.swapFactory,
      wegaz: d.wegaz,
      etx: d.etx,
      etxFarms: d.etxFarms,
    };
  }, [chainId]);
}

type PairMeta = {
  pair: Address;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  /** LP tokens currently in the user's wallet (removable directly). */
  lpBalance: bigint;
  /** LP tokens the user has staked in ETXFarms (must be unstaked first). */
  farmLpBalance: bigint;
  /** Pool id in ETXFarms when this pair has a registered farm pool. */
  farmPid: number | null;
};

export function PoolPositionsList() {
  const { address, isConnected } = useAccount();
  const ctx = useCtx();

  // Enumerate all pairs via factory.allPairsLength + factory.allPairs(i).
  const pairsLenQ = useReadContract({
    abi: abis.factoryAbi,
    address: ctx?.factory,
    functionName: 'allPairsLength',
    query: { enabled: Boolean(ctx) },
  });
  const pairsLen = Number((pairsLenQ.data as bigint | undefined) ?? 0n);

  const pairAddrQs = useReadContracts({
    allowFailure: false,
    contracts:
      ctx && pairsLen > 0
        ? Array.from({ length: pairsLen }, (_, i) => ({
            abi: abis.factoryAbi,
            address: ctx.factory,
            functionName: 'allPairs' as const,
            args: [BigInt(i)],
          }))
        : [],
    query: { enabled: Boolean(ctx) && pairsLen > 0 },
  });

  const pairAddrs: Address[] = useMemo(() => {
    if (!pairAddrQs.data) return [];
    return pairAddrQs.data as Address[];
  }, [pairAddrQs.data]);

  // For each pair: token0, token1, reserves, totalSupply, user LP balance.
  const pairReads = useReadContracts({
    allowFailure: false,
    contracts:
      ctx && address && pairAddrs.length > 0
        ? pairAddrs.flatMap((pair) => [
            {
              abi: abis.pairAbi,
              address: pair,
              functionName: 'token0' as const,
            },
            {
              abi: abis.pairAbi,
              address: pair,
              functionName: 'token1' as const,
            },
            {
              abi: abis.pairAbi,
              address: pair,
              functionName: 'getReserves' as const,
            },
            {
              abi: abis.pairAbi,
              address: pair,
              functionName: 'totalSupply' as const,
            },
            {
              abi: abis.pairAbi,
              address: pair,
              functionName: 'balanceOf' as const,
              args: [address],
            },
          ])
        : [],
    query: { enabled: Boolean(ctx && address) && pairAddrs.length > 0 },
  });

  // Collect (token0, token1) so we can do a second batch read for symbol/decimals.
  const tokens = useMemo<Address[]>(() => {
    if (!pairReads.data || pairAddrs.length === 0) return [];
    const seen = new Set<string>();
    const out: Address[] = [];
    for (let i = 0; i < pairAddrs.length; i++) {
      const t0 = pairReads.data[i * 5] as Address;
      const t1 = pairReads.data[i * 5 + 1] as Address;
      if (t0 && !seen.has(t0.toLowerCase())) {
        seen.add(t0.toLowerCase());
        out.push(t0);
      }
      if (t1 && !seen.has(t1.toLowerCase())) {
        seen.add(t1.toLowerCase());
        out.push(t1);
      }
    }
    return out;
  }, [pairReads.data, pairAddrs.length]);

  const tokenMetaReads = useReadContracts({
    allowFailure: true,
    contracts: tokens.flatMap((t) => [
      {
        abi: abis.erc20Abi,
        address: t,
        functionName: 'symbol' as const,
      },
      {
        abi: abis.erc20Abi,
        address: t,
        functionName: 'decimals' as const,
      },
    ]),
    query: { enabled: tokens.length > 0 },
  });

  // ─── ETXFarms staked-LP overlay ────────────────────────────────────────
  // When a user stakes their LP into a farm pool, the LP token leaves their
  // wallet (the farm contract holds it). Without surfacing the farm-side
  // balance, the position would disappear from /pool entirely. We read every
  // farm pool's lpToken and per-user staked amount so we can fold farmed LP
  // back into the same row as the wallet LP.
  const farmsDeployed = Boolean(ctx) && ctx!.etxFarms !== ZERO;
  const farmPoolsLenQ = useReadContract({
    abi: abis.etxFarmsAbi,
    address: ctx?.etxFarms,
    functionName: 'poolLength',
    query: { enabled: farmsDeployed },
  });
  const farmPoolCount = Number(
    (farmPoolsLenQ.data as bigint | undefined) ?? 0n,
  );

  const farmPoolInfosQ = useReadContracts({
    allowFailure: false,
    contracts:
      ctx && farmsDeployed && farmPoolCount > 0
        ? Array.from({ length: farmPoolCount }, (_, pid) => ({
            abi: abis.etxFarmsAbi,
            address: ctx.etxFarms,
            functionName: 'poolInfo' as const,
            args: [BigInt(pid)],
          }))
        : [],
    query: { enabled: farmsDeployed && farmPoolCount > 0 },
  });

  const farmUserInfosQ = useReadContracts({
    allowFailure: false,
    contracts:
      ctx && address && farmsDeployed && farmPoolCount > 0
        ? Array.from({ length: farmPoolCount }, (_, pid) => ({
            abi: abis.etxFarmsAbi,
            address: ctx.etxFarms,
            functionName: 'userInfo' as const,
            args: [BigInt(pid), address],
          }))
        : [],
    query: {
      enabled: Boolean(ctx && address) && farmsDeployed && farmPoolCount > 0,
    },
  });

  /** Map from pair address (lowercased) -> { pid, staked }. */
  const farmStakedByPair = useMemo(() => {
    const m = new Map<string, { pid: number; staked: bigint }>();
    const infos = farmPoolInfosQ.data as
      | ReadonlyArray<readonly [Address, bigint, bigint, bigint]>
      | undefined;
    const users = farmUserInfosQ.data as
      | ReadonlyArray<readonly [bigint, bigint]>
      | undefined;
    if (!infos) return m;
    for (let pid = 0; pid < farmPoolCount; pid++) {
      const info = infos[pid];
      if (!info) continue;
      const lpToken = info[0];
      const staked = users?.[pid]?.[0] ?? 0n;
      m.set(lpToken.toLowerCase(), { pid, staked });
    }
    return m;
  }, [farmPoolInfosQ.data, farmUserInfosQ.data, farmPoolCount]);

  const tokenSymbolOverride = useMemo(() => {
    // On the DEX, WEGAZ represents pooled EGAZ. Show "EGAZ" in the UI but
    // still use WEGAZ as the on-chain address.
    const m = new Map<string, string>();
    if (ctx) m.set(ctx.wegaz.toLowerCase(), 'EGAZ');
    return m;
  }, [ctx]);

  const tokenMeta = useMemo<Map<string, { symbol: string; decimals: number }>>(() => {
    const m = new Map<string, { symbol: string; decimals: number }>();
    if (!tokenMetaReads.data) return m;
    tokens.forEach((addr, i) => {
      const symRow = tokenMetaReads.data?.[i * 2];
      const decRow = tokenMetaReads.data?.[i * 2 + 1];
      const override = tokenSymbolOverride.get(addr.toLowerCase());
      const symbol =
        override ??
        (symRow && symRow.status === 'success'
          ? (symRow.result as string)
          : addr.slice(0, 6));
      const decimals =
        decRow && decRow.status === 'success' ? Number(decRow.result as number) : 18;
      m.set(addr.toLowerCase(), { symbol, decimals });
    });
    return m;
  }, [tokens, tokenMetaReads.data, tokenSymbolOverride]);

  const positions = useMemo<PairMeta[]>(() => {
    if (!pairReads.data || pairAddrs.length === 0) return [];
    const out: PairMeta[] = [];
    for (let i = 0; i < pairAddrs.length; i++) {
      const lpBalance = pairReads.data[i * 5 + 4] as bigint;
      const pairAddr = pairAddrs[i];
      const farm = farmStakedByPair.get(pairAddr.toLowerCase());
      const farmLpBalance = farm?.staked ?? 0n;
      // A position is visible if the user holds LP either in their wallet OR
      // in ETXFarms. Otherwise they have no claim on this pair.
      if (lpBalance === 0n && farmLpBalance === 0n) continue;
      const token0 = pairReads.data[i * 5] as Address;
      const token1 = pairReads.data[i * 5 + 1] as Address;
      const reserves = pairReads.data[i * 5 + 2] as readonly [bigint, bigint, number];
      const totalSupply = pairReads.data[i * 5 + 3] as bigint;
      const meta0 = tokenMeta.get(token0.toLowerCase());
      const meta1 = tokenMeta.get(token1.toLowerCase());
      out.push({
        pair: pairAddr,
        token0,
        token1,
        symbol0: meta0?.symbol ?? token0.slice(0, 6),
        symbol1: meta1?.symbol ?? token1.slice(0, 6),
        decimals0: meta0?.decimals ?? 18,
        decimals1: meta1?.decimals ?? 18,
        reserve0: reserves[0],
        reserve1: reserves[1],
        totalSupply,
        lpBalance,
        farmLpBalance,
        farmPid: farm?.pid ?? null,
      });
    }
    return out;
  }, [pairReads.data, pairAddrs, tokenMeta, farmStakedByPair]);

  const refetchAll = () => {
    void Promise.all([
      pairsLenQ.refetch(),
      pairAddrQs.refetch(),
      pairReads.refetch(),
      tokenMetaReads.refetch(),
      farmPoolsLenQ.refetch(),
      farmPoolInfosQ.refetch(),
      farmUserInfosQ.refetch(),
    ]).catch(() => {
      /* best-effort */
    });
  };

  if (!ctx) return null;

  if (!isConnected) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-white/60">
        Connect your wallet to see your liquidity positions.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-white/80">Your positions</h2>
      {positions.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-white/60">
          No LP positions yet. Add liquidity above to start earning 0.25% of every swap on your pool.
        </div>
      ) : (
        positions.map((p) => (
          <PositionRow
            key={p.pair}
            ctx={ctx}
            pos={p}
            onTxConfirmed={refetchAll}
          />
        ))
      )}
    </div>
  );
}

function PositionRow({
  ctx,
  pos,
  onTxConfirmed,
}: {
  ctx: Ctx;
  pos: PairMeta;
  onTxConfirmed: () => void;
}) {
  const { address } = useAccount();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState<number>(100);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [pendingTxHash, setPendingTxHash] = useState<Hex | undefined>();

  const { writeContractAsync, data: txHash, isPending, reset: resetWrite } =
    useWriteContract();
  const activeHash = pendingTxHash ?? txHash;
  const receipt = useWaitForTransactionReceipt({
    hash: activeHash,
    query: { enabled: Boolean(activeHash) },
  });

  const lpAllowance = useReadContract({
    abi: abis.erc20Abi,
    address: pos.pair,
    functionName: 'allowance',
    args: address ? [address, ctx.router] : undefined,
    query: { enabled: Boolean(address) },
  });

  useEffect(() => {
    if (!receipt.isSuccess) return;
    onTxConfirmed();
    void lpAllowance.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, activeHash]);

  // Combine wallet LP + farm-staked LP so the row reflects the user's full
  // claim on the pair. Share % and underlying-token amounts use the combined
  // total. The remove-liquidity slider below operates on wallet LP only,
  // since farmed LP must be unstaked from /farms first.
  const totalLp = pos.lpBalance + pos.farmLpBalance;

  const shareBps = useMemo(() => {
    if (pos.totalSupply === 0n) return 0n;
    return (totalLp * 10_000n) / pos.totalSupply;
  }, [pos.totalSupply, totalLp]);

  const userAmount0 = useMemo(() => {
    if (pos.totalSupply === 0n) return 0n;
    return (pos.reserve0 * totalLp) / pos.totalSupply;
  }, [pos.reserve0, totalLp, pos.totalSupply]);
  const userAmount1 = useMemo(() => {
    if (pos.totalSupply === 0n) return 0n;
    return (pos.reserve1 * totalLp) / pos.totalSupply;
  }, [pos.reserve1, totalLp, pos.totalSupply]);

  const liquidityToRemove = useMemo(() => {
    return (pos.lpBalance * BigInt(pct)) / 100n;
  }, [pos.lpBalance, pct]);

  const expectedAmount0 = useMemo(() => {
    if (pos.totalSupply === 0n) return 0n;
    return (pos.reserve0 * liquidityToRemove) / pos.totalSupply;
  }, [pos.reserve0, liquidityToRemove, pos.totalSupply]);
  const expectedAmount1 = useMemo(() => {
    if (pos.totalSupply === 0n) return 0n;
    return (pos.reserve1 * liquidityToRemove) / pos.totalSupply;
  }, [pos.reserve1, liquidityToRemove, pos.totalSupply]);

  const min0 = (expectedAmount0 * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  const min1 = (expectedAmount1 * (10_000n - DEFAULT_SLIPPAGE_BPS)) / 10_000n;

  const lpAllowanceVal = (lpAllowance.data as bigint | undefined) ?? 0n;
  const needsApproval = liquidityToRemove > 0n && lpAllowanceVal < liquidityToRemove;

  // If one of the tokens is WEGAZ, prefer the native-EGAZ variant so the
  // user gets EGAZ directly.
  const isWegaz = (a: Address) => a.toLowerCase() === ctx.wegaz.toLowerCase();
  const wegazSide: 0 | 1 | null = isWegaz(pos.token0) ? 0 : isWegaz(pos.token1) ? 1 : null;

  async function onApproveLp() {
    if (!address) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    try {
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: pos.pair,
        functionName: 'approve',
        args: [ctx.router, MAX_UINT256],
      });
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'LP approval failed'));
    }
  }

  async function onRemove() {
    if (!address || liquidityToRemove === 0n) return;
    setSubmitError(undefined);
    setPendingTxHash(undefined);
    resetWrite();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    try {
      let hash: Hex;
      if (wegazSide !== null) {
        // removeLiquidityEGAZ unwraps WEGAZ → native EGAZ and sends to user.
        const otherToken = wegazSide === 0 ? pos.token1 : pos.token0;
        const minToken = wegazSide === 0 ? min1 : min0;
        const minEgaz = wegazSide === 0 ? min0 : min1;
        hash = await writeContractAsync({
          abi: abis.routerAbi,
          address: ctx.router,
          functionName: 'removeLiquidityEGAZ',
          args: [
            otherToken,
            liquidityToRemove,
            minToken,
            minEgaz,
            address,
            deadline,
          ],
        });
      } else {
        hash = await writeContractAsync({
          abi: abis.routerAbi,
          address: ctx.router,
          functionName: 'removeLiquidity',
          args: [
            pos.token0,
            pos.token1,
            liquidityToRemove,
            min0,
            min1,
            address,
            deadline,
          ],
        });
      }
      setPendingTxHash(hash);
    } catch (err) {
      setSubmitError(describeWriteError(err, 'Remove liquidity failed'));
    }
  }

  const isWorking = isPending || receipt.isLoading;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div
        className="flex cursor-pointer items-center justify-between"
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <div className="text-sm font-semibold">
            {pos.symbol0} / {pos.symbol1}
          </div>
          <div className="text-xs text-white/50">
            {formatTruncated(userAmount0, pos.decimals0, 6)} {pos.symbol0} +{' '}
            {formatTruncated(userAmount1, pos.decimals1, 6)} {pos.symbol1}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-white/60">
            {formatTruncated(totalLp, 18, 6)} LP
          </div>
          {pos.farmLpBalance > 0n && (
            <div className="text-[10px] text-white/40">
              {formatTruncated(pos.lpBalance, 18, 4)} wallet ·{' '}
              {formatTruncated(pos.farmLpBalance, 18, 4)} farmed
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            {Number(shareBps) / 100}% share
          </div>
        </div>
      </div>

      {open && pos.lpBalance === 0n && pos.farmLpBalance > 0n ? (
        <div className="space-y-2 border-t border-white/5 pt-3 text-xs text-white/60">
          <div>
            All of this position’s LP is currently staked in ETXFarms. Unstake on{' '}
            <a href="/farms" className="text-brand-accent hover:underline">
              /farms
            </a>{' '}
            first to remove liquidity.
          </div>
        </div>
      ) : open && (
        <div className="space-y-3 border-t border-white/5 pt-3">
          {pos.farmLpBalance > 0n && (
            <div className="text-[11px] text-white/50">
              Slider controls the {formatTruncated(pos.lpBalance, 18, 4)} LP in
              your wallet. To free up the{' '}
              {formatTruncated(pos.farmLpBalance, 18, 4)} LP staked in{' '}
              <a href="/farms" className="text-brand-accent hover:underline">
                ETXFarms
              </a>
              , unstake there first.
            </div>
          )}
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={100}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              className="flex-1 accent-emerald-400"
            />
            <div className="w-12 text-right text-sm tabular-nums">{pct}%</div>
          </div>
          <div className="flex items-center gap-2">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                onClick={() => setPct(p)}
                className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
              >
                {p}%
              </button>
            ))}
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/70 space-y-1">
            <div className="flex justify-between">
              <span className="text-white/50">You receive</span>
              <span>
                {formatTruncated(expectedAmount0, pos.decimals0, 6)} {pos.symbol0} +{' '}
                {formatTruncated(expectedAmount1, pos.decimals1, 6)} {pos.symbol1}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/50">Minimum (0.5% slippage)</span>
              <span>
                {formatTruncated(min0, pos.decimals0, 6)} / {formatTruncated(min1, pos.decimals1, 6)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/50">Pair</span>
              <span className="font-mono">
                {pos.pair.slice(0, 6)}…{pos.pair.slice(-4)}
              </span>
            </div>
          </div>
          <button
            onClick={() => void (needsApproval ? onApproveLp() : onRemove())}
            disabled={isWorking || liquidityToRemove === 0n}
            className="w-full rounded-xl bg-brand-accent px-4 py-2 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isWorking
              ? 'Waiting for confirmation…'
              : needsApproval
                ? 'Approve LP token'
                : 'Remove liquidity'}
          </button>
          {submitError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {submitError}
            </div>
          )}
          {receipt.isSuccess && activeHash && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
              Confirmed.
            </div>
          )}
        </div>
      )}
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

function describeWriteError(err: unknown, fallback: string): string | undefined {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return undefined;
    return err.shortMessage ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
