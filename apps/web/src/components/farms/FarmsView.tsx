'use client';

import { useMemo } from 'react';
import { useChainId, useReadContract, useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import {
  DEPLOYMENTS,
  abis,
  isSupportedChainId,
  type SupportedChainId,
} from '@etica-hub/shared';
import { FarmPoolCard } from './FarmPoolCard';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

export function FarmsView() {
  const chainId = useChainId();
  const supported = isSupportedChainId(chainId);
  const typedChainId = supported ? (chainId as SupportedChainId) : undefined;
  const etxFarms = typedChainId ? DEPLOYMENTS[typedChainId].etxFarms : ZERO;
  const etx = typedChainId ? DEPLOYMENTS[typedChainId].etx : ZERO;
  const deployed = etxFarms !== ZERO && etx !== ZERO;

  // Read poolLength to discover pool count dynamically.
  const poolLengthQuery = useReadContract({
    abi: abis.etxFarmsAbi,
    address: etxFarms,
    functionName: 'poolLength',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });

  const poolCount = Number((poolLengthQuery.data as bigint | undefined) ?? 0n);
  const pids = useMemo(
    () => Array.from({ length: poolCount }, (_, i) => i),
    [poolCount],
  );

  const poolInfosQuery = useReadContracts({
    allowFailure: false,
    contracts: deployed
      ? pids.map(
          (pid) =>
            ({
              abi: abis.etxFarmsAbi,
              address: etxFarms,
              functionName: 'poolInfo',
              args: [BigInt(pid)],
            }) as const,
        )
      : [],
    query: { enabled: deployed && poolCount > 0, refetchInterval: 30_000 },
  });

  const totalAllocQuery = useReadContract({
    abi: abis.etxFarmsAbi,
    address: etxFarms,
    functionName: 'totalAllocPoint',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const totalAlloc = (totalAllocQuery.data as bigint | undefined) ?? 0n;

  if (!supported) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200/80">
        Unsupported chain. Switch to Etica mainnet (61803) to use the farms.
      </div>
    );
  }

  if (!deployed) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-white/70">
          <div className="mb-1 text-base font-semibold text-white">
            ETXFarms not deployed yet
          </div>
          <p>
            The ETXFarms LP staking contract has not been deployed on this chain. Operators can
            deploy it at{' '}
            <a href="/deploy/farms" className="text-brand-accent hover:underline">
              /deploy/farms
            </a>{' '}
            and then paste the address into{' '}
            <span className="font-mono">packages/shared/src/addresses.ts</span>.
          </p>
          <p className="mt-2 text-white/50">
            Once deployed, this page will light up with per-pool stake / unstake / claim
            controls, trailing APR estimates, and on-chain reward accrual.
          </p>
        </div>
        <FarmsHowItWorks />
      </div>
    );
  }

  if (poolCount === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-white/70">
          <div className="mb-1 text-base font-semibold text-white">No farms configured yet</div>
          <p>
            ETXFarms is deployed but the owner has not registered any pools. Expected pools at
            launch: ETI/ETX (weight 5000) and EGAZ/ETX (weight 5000).
          </p>
        </div>
        <FarmsHowItWorks />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FarmsSummary etxFarms={etxFarms} />
      <div className="grid gap-4 md:grid-cols-2">
        {pids.map((pid) => {
          const info = (
            poolInfosQuery.data as
              | ReadonlyArray<readonly [Address, bigint, bigint, bigint]>
              | undefined
          )?.[pid];
          if (!info) return null;
          const [lp, allocPoint, totalStaked] = info;
          return (
            <FarmPoolCard
              key={pid}
              pid={pid}
              chainId={typedChainId!}
              etxFarms={etxFarms}
              lp={lp}
              allocPoint={allocPoint}
              totalStaked={totalStaked}
              totalAlloc={totalAlloc}
            />
          );
        })}
      </div>
      <FarmsHowItWorks />
    </div>
  );
}

function FarmsSummary({ etxFarms }: { etxFarms: Address }) {
  const totalAllocQuery = useReadContract({
    abi: abis.etxFarmsAbi,
    address: etxFarms,
    functionName: 'totalAllocPoint',
    query: { refetchInterval: 30_000 },
  });
  const fallbackQuery = useReadContract({
    abi: abis.etxFarmsAbi,
    address: etxFarms,
    functionName: 'fallbackRecipient',
    query: { refetchInterval: 60_000 },
  });
  const totalAlloc = (totalAllocQuery.data as bigint | undefined) ?? 0n;
  const fallback = (fallbackQuery.data as Address | undefined) ?? ZERO;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-xs text-white/60">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <span className="text-white/40">Contract:</span>{' '}
          <span className="font-mono break-all">{etxFarms}</span>
        </div>
        <div>
          <span className="text-white/40">Total alloc:</span>{' '}
          <span className="font-mono">{totalAlloc.toString()}</span>
        </div>
        <div>
          <span className="text-white/40">Fallback (idle-pool sink):</span>{' '}
          <span className="font-mono break-all">{fallback}</span>
        </div>
      </div>
    </div>
  );
}

function FarmsHowItWorks() {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs text-white/50">
      <div className="font-medium text-white/70">How ETXFarms works</div>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>
          Stake EticaSwap LP tokens (ETI/ETX or EGAZ/ETX). Your LP keeps earning its regular
          swap-fee yield on top of ETX farm rewards — staking here does not leave the pool.
        </li>
        <li>
          Each harvest cycle, the Treasury Harvester forwards 10% of fees to ETXFarms via a
          permissionless <span className="font-mono">distributeRewards</span> call. That ETX is
          split across pools by allocation weight, then pro-rata across stakers in each pool.
        </li>
        <li>
          No emissions: the contract only distributes ETX explicitly pushed in. No new supply is
          ever minted.
        </li>
        <li>
          No lockup, no deposit/withdraw fee. You can harvest rewards at any time without
          unstaking, or exit with <span className="font-mono">emergencyWithdraw</span> (forfeits
          pending rewards).
        </li>
      </ul>
    </div>
  );
}
