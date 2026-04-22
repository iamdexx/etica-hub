'use client';

import { useMemo } from 'react';
import { formatUnits, type Address } from 'viem';
import { useReadContracts } from 'wagmi';
import { abis } from '@etica-hub/shared';
import { useStakedEtxApy } from '@/hooks/useStakedEtxApy';

interface StakeStatsProps {
  stakedETX: Address;
}

/**
 * Top-of-page stat strip: pricePerShare (ETX per 1 stETX), current APY,
 * total ETX under management, total stETX in circulation.
 *
 * APY is derived from `RewardsDistributed` events over the last 7 days,
 * annualized. See hooks/useStakedEtxApy.ts.
 */
export function StakeStats({ stakedETX }: StakeStatsProps) {
  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        abi: abis.stakedEtxAbi,
        address: stakedETX,
        functionName: 'pricePerShare',
      } as const,
      {
        abi: abis.stakedEtxAbi,
        address: stakedETX,
        functionName: 'totalAssets',
      } as const,
      {
        abi: abis.stakedEtxAbi,
        address: stakedETX,
        functionName: 'totalSupply',
      } as const,
    ],
    query: { refetchInterval: 12_000 },
  });

  const [rate, totalAssets, totalSupply] = (reads.data as
    | [bigint, bigint, bigint]
    | undefined) ?? [undefined, undefined, undefined];

  const apy = useStakedEtxApy(stakedETX);

  const rateLabel = useMemo(() => {
    if (rate === undefined) return '—';
    return `${Number(formatUnits(rate, 18)).toFixed(6)} ETX / stETX`;
  }, [rate]);

  const totalAssetsLabel = useMemo(() => {
    if (totalAssets === undefined) return '—';
    return `${Number(formatUnits(totalAssets, 18)).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} ETX`;
  }, [totalAssets]);

  const totalSharesLabel = useMemo(() => {
    if (totalSupply === undefined) return '—';
    return `${Number(formatUnits(totalSupply, 18)).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} stETX`;
  }, [totalSupply]);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Exchange rate" value={rateLabel} sub="1 stETX =" />
      <Stat
        label="7d APY"
        value={apy.loading ? '…' : apy.percent !== null ? `${apy.percent.toFixed(2)}%` : '—'}
        sub={apy.sampleCount === 0 ? 'no rewards yet' : `from ${apy.sampleCount} harvests`}
      />
      <Stat label="Total staked" value={totalAssetsLabel} sub="TVL (ETX)" />
      <Stat label="Shares outstanding" value={totalSharesLabel} sub="total stETX" />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="text-[11px] uppercase tracking-wider text-white/50">{label}</div>
      <div className="mt-1 truncate text-base font-semibold text-white" title={value}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-white/40">{sub}</div>}
    </div>
  );
}
