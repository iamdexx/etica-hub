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
import { formatTokenBalance } from '@/lib/utils';
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
  type SupportedChainId,
} from '@etica-hub/shared';

interface FarmPoolCardProps {
  pid: number;
  chainId: SupportedChainId;
  etxFarms: Address;
  lp: Address;
  allocPoint: bigint;
  totalStaked: bigint;
  totalAlloc: bigint;
}

type Tab = 'stake' | 'unstake';
type FlowState =
  | { status: 'idle' }
  | { status: 'approving'; hash?: Hex }
  | { status: 'staking'; hash?: Hex }
  | { status: 'unstaking'; hash?: Hex }
  | { status: 'harvesting'; hash?: Hex }
  | { status: 'error'; error: string };

const MAX_UINT256 = (1n << 256n) - 1n;

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function tokenShortName(
  token: Address,
  {
    etx,
    wegaz,
    eti,
    stakedEtx,
  }: { etx: Address; wegaz: Address; eti: Address; stakedEtx: Address },
): string {
  const t = token.toLowerCase();
  if (t === etx.toLowerCase()) return 'ETX';
  if (t === stakedEtx.toLowerCase()) return 'stETX';
  if (t === wegaz.toLowerCase()) return 'EGAZ';
  if (t === eti.toLowerCase()) return 'ETI';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function FarmPoolCard({
  pid,
  chainId,
  etxFarms,
  lp,
  allocPoint,
  totalStaked,
  totalAlloc,
}: FarmPoolCardProps) {
  const { address, isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>('stake');
  const [amount, setAmount] = useState('');
  const [flow, setFlow] = useState<FlowState>({ status: 'idle' });

  // Resolve pair token0 / token1 for a human-readable label.
  const pairMetaQuery = useReadContracts({
    allowFailure: true,
    contracts: [
      { abi: abis.pairAbi, address: lp, functionName: 'token0' } as const,
      { abi: abis.pairAbi, address: lp, functionName: 'token1' } as const,
    ],
    query: { staleTime: Infinity },
  });

  const token0 = pairMetaQuery.data?.[0]?.result as Address | undefined;
  const token1 = pairMetaQuery.data?.[1]?.result as Address | undefined;

  // Canonical token addresses from shared constants for the label resolver.
  const etx = DEPLOYMENTS[chainId].etx;
  const wegaz = DEPLOYMENTS[chainId].wegaz;
  const eti = EXTERNAL_ADDRESSES[chainId].eti;
  const stakedEtx = DEPLOYMENTS[chainId].stakedETX;

  const pairLabel = useMemo(() => {
    if (!token0 || !token1) return 'LP';
    const s0 = tokenShortName(token0, { etx, wegaz, eti, stakedEtx });
    const s1 = tokenShortName(token1, { etx, wegaz, eti, stakedEtx });
    // Put the non-ETX token first for readability (e.g. "ETI/ETX").
    if (s1 === 'ETX') return `${s0}/ETX`;
    if (s0 === 'ETX') return `${s1}/ETX`;
    return `${s0}/${s1}`;
  }, [token0, token1, etx, wegaz, eti, stakedEtx]);

  const reads = useReadContracts({
    allowFailure: false,
    contracts: address
      ? [
          {
            abi: abis.erc20Abi,
            address: lp,
            functionName: 'balanceOf',
            args: [address],
          } as const,
          {
            abi: abis.erc20Abi,
            address: lp,
            functionName: 'allowance',
            args: [address, etxFarms],
          } as const,
          {
            abi: abis.etxFarmsAbi,
            address: etxFarms,
            functionName: 'userInfo',
            args: [BigInt(pid), address],
          } as const,
          {
            abi: abis.etxFarmsAbi,
            address: etxFarms,
            functionName: 'pendingReward',
            args: [BigInt(pid), address],
          } as const,
        ]
      : [],
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });

  const rawUserInfo = reads.data?.[2] as readonly [bigint, bigint] | undefined;
  const lpBalance = (reads.data?.[0] as bigint | undefined) ?? 0n;
  const allowance = (reads.data?.[1] as bigint | undefined) ?? 0n;
  const stakedAmount = rawUserInfo?.[0] ?? 0n;
  const pending = (reads.data?.[3] as bigint | undefined) ?? 0n;

  const parsedAmount = useMemo<bigint | null>(() => {
    const t = amount.trim();
    if (!t) return null;
    try {
      return parseUnits(t, 18);
    } catch {
      return null;
    }
  }, [amount]);

  const { writeContractAsync } = useWriteContract();
  const lastHash =
    flow.status !== 'idle' && flow.status !== 'error' ? flow.hash : undefined;
  const receiptQuery = useWaitForTransactionReceipt({
    hash: lastHash,
    query: { enabled: Boolean(lastHash) },
  });

  useEffect(() => {
    if (receiptQuery.isSuccess && lastHash) {
      const wasApproving = flow.status === 'approving';
      setFlow({ status: 'idle' });
      if (!wasApproving) setAmount('');
      void reads.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptQuery.isSuccess, lastHash]);

  const busy = flow.status !== 'idle' && flow.status !== 'error';
  const canStake =
    tab === 'stake' &&
    parsedAmount !== null &&
    parsedAmount > 0n &&
    parsedAmount <= lpBalance;
  const canUnstake =
    tab === 'unstake' &&
    parsedAmount !== null &&
    parsedAmount > 0n &&
    parsedAmount <= stakedAmount;
  const needsApprove = tab === 'stake' && parsedAmount !== null && parsedAmount > allowance;

  async function onApprove() {
    if (!parsedAmount || !address) return;
    try {
      setFlow({ status: 'approving' });
      const hash = await writeContractAsync({
        abi: abis.erc20Abi,
        address: lp,
        functionName: 'approve',
        args: [etxFarms, MAX_UINT256],
      });
      setFlow({ status: 'approving', hash });
    } catch (err) {
      setFlow({ status: 'error', error: shortError(err) });
    }
  }

  async function onStake() {
    if (!parsedAmount || !address) return;
    try {
      setFlow({ status: 'staking' });
      const hash = await writeContractAsync({
        abi: abis.etxFarmsAbi,
        address: etxFarms,
        functionName: 'deposit',
        args: [BigInt(pid), parsedAmount],
      });
      setFlow({ status: 'staking', hash });
    } catch (err) {
      setFlow({ status: 'error', error: shortError(err) });
    }
  }

  async function onUnstake() {
    if (!parsedAmount || !address) return;
    try {
      setFlow({ status: 'unstaking' });
      const hash = await writeContractAsync({
        abi: abis.etxFarmsAbi,
        address: etxFarms,
        functionName: 'withdraw',
        args: [BigInt(pid), parsedAmount],
      });
      setFlow({ status: 'unstaking', hash });
    } catch (err) {
      setFlow({ status: 'error', error: shortError(err) });
    }
  }

  async function onHarvest() {
    if (!address) return;
    try {
      setFlow({ status: 'harvesting' });
      const hash = await writeContractAsync({
        abi: abis.etxFarmsAbi,
        address: etxFarms,
        functionName: 'harvest',
        args: [BigInt(pid)],
      });
      setFlow({ status: 'harvesting', hash });
    } catch (err) {
      setFlow({ status: 'error', error: shortError(err) });
    }
  }

  const weightPct =
    totalAlloc > 0n ? Number((allocPoint * 10000n) / totalAlloc) / 100 : 0;

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm uppercase tracking-wide text-white/40">Pool #{pid}</div>
          <h2 className="truncate text-lg font-semibold">{pairLabel} LP</h2>
        </div>
        <div className="shrink-0 text-right text-xs text-white/60">
          <div>
            Weight <span className="font-mono">{weightPct.toFixed(2)}%</span>
          </div>
          <div>
            Staked <span className="font-mono">{formatTokenBalance(totalStaked)}</span>
          </div>
        </div>
      </header>

      <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
        <div className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="text-white/40">Your stake</div>
          <div
            className="mt-1 truncate font-mono text-sm text-white"
            title={`${formatUnits(stakedAmount, 18)} LP`}
          >
            {formatTokenBalance(stakedAmount)} LP
          </div>
        </div>
        <div className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="text-white/40">Pending</div>
          <div
            className="mt-1 truncate font-mono text-sm text-emerald-300"
            title={`${formatUnits(pending, 18)} ETX`}
          >
            {formatTokenBalance(pending)} ETX
          </div>
        </div>
      </div>

      <div className="mb-3 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 p-1 text-sm">
        <TabButton active={tab === 'stake'} onClick={() => setTab('stake')}>
          Stake
        </TabButton>
        <TabButton active={tab === 'unstake'} onClick={() => setTab('unstake')}>
          Unstake
        </TabButton>
      </div>

      <label className="mb-2 block text-xs text-white/60">Amount (LP)</label>
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0.0"
          spellCheck={false}
          className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm focus:border-brand-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() =>
            setAmount(formatUnits(tab === 'stake' ? lpBalance : stakedAmount, 18))
          }
          disabled={!isConnected}
          className="rounded-lg border border-white/10 bg-white/5 px-3 text-xs text-white/70 transition hover:bg-white/10 disabled:opacity-40"
        >
          Max
        </button>
      </div>
      <div
        className="mt-1 truncate text-[11px] text-white/40"
        title={
          tab === 'stake'
            ? `${formatUnits(lpBalance, 18)} LP`
            : `${formatUnits(stakedAmount, 18)} LP`
        }
      >
        {tab === 'stake' ? (
          <>Wallet LP: {formatTokenBalance(lpBalance)}</>
        ) : (
          <>Staked LP: {formatTokenBalance(stakedAmount)}</>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {tab === 'stake' && needsApprove && (
          <button
            type="button"
            onClick={onApprove}
            disabled={!isConnected || busy || !canStake}
            className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {flow.status === 'approving' ? 'Approving…' : 'Approve LP'}
          </button>
        )}
        {tab === 'stake' && !needsApprove && (
          <button
            type="button"
            onClick={onStake}
            disabled={!isConnected || busy || !canStake}
            className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {flow.status === 'staking' ? 'Staking…' : 'Stake LP'}
          </button>
        )}
        {tab === 'unstake' && (
          <button
            type="button"
            onClick={onUnstake}
            disabled={!isConnected || busy || !canUnstake}
            className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {flow.status === 'unstaking' ? 'Unstaking…' : 'Unstake LP'}
          </button>
        )}
        <button
          type="button"
          onClick={onHarvest}
          disabled={!isConnected || busy || pending === 0n}
          className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {flow.status === 'harvesting' ? 'Harvesting…' : 'Claim rewards'}
        </button>

        {flow.status === 'error' && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {flow.error}
          </div>
        )}
        {lastHash && receiptQuery.isLoading && (
          <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/60">
            Waiting for confirmation…
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px] text-white/30">
        Pool address <span className="font-mono break-all">{lp}</span>
      </p>
    </section>
  );
}

function TabButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex-1 rounded-full px-3 py-1 text-sm transition ' +
        (active ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80')
      }
    >
      {children}
    </button>
  );
}
