'use client';

import { useEffect, useState } from 'react';
import { formatUnits, parseAbiItem, type Address } from 'viem';
import { usePublicClient, useReadContract } from 'wagmi';
import { abis } from '@etica-hub/shared';

/**
 * Computes a rolling 7-day APY for the stETX vault.
 *
 * The math is simple: APY ≈ (totalRewards_7d / totalAssets_at_start_of_window) * (365 / 7).
 *
 * We approximate `totalAssets_at_start_of_window` by `totalAssets_now − totalRewards_7d`.
 * This is correct to first order — deposits and withdraws happen at the current rate
 * so they do not themselves change rate, only rewards do. Any deposits inside the
 * window inflate the denominator slightly (makes reported APY conservative); any
 * withdraws inside the window deflate it slightly (makes reported APY slightly
 * optimistic). Net: accurate to within a few percent of a rigorous IRR for typical
 * flows, without an indexer.
 *
 * When there are no rewards yet, returns `percent = null, sampleCount = 0` so the
 * UI can render "no rewards yet" instead of 0%.
 */

// How far back to look for RewardsDistributed events. ~7 days at Etica's ~5s
// blocktime (~17,280 blocks/day) = ~120,960 blocks. We round up to 125k.
const LOOKBACK_BLOCKS = 125_000n;
// Etica public RPCs typically cap getLogs at ~10k blocks per call.
const PAGE_SIZE = 10_000n;
const REWARDS_EVENT = parseAbiItem(
  'event RewardsDistributed(address indexed from, uint256 amount)',
);

export interface StakedEtxApy {
  /** 7d-annualized APY as a percent, e.g. 4.23. null when unknown. */
  percent: number | null;
  /** Number of RewardsDistributed events found in the window. */
  sampleCount: number;
  loading: boolean;
  error: string | null;
}

export function useStakedEtxApy(stakedETX: Address): StakedEtxApy {
  const publicClient = usePublicClient();

  const totalAssetsQuery = useReadContract({
    abi: abis.stakedEtxAbi,
    address: stakedETX,
    functionName: 'totalAssets',
    query: { refetchInterval: 30_000 },
  });
  const totalAssets = totalAssetsQuery.data as bigint | undefined;

  const [state, setState] = useState<StakedEtxApy>({
    percent: null,
    sampleCount: 0,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!publicClient || !stakedETX || totalAssets === undefined) return;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const head = await publicClient.getBlockNumber();
        const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;

        let totalRewards = 0n;
        let count = 0;
        for (let start = from; start <= head; start += PAGE_SIZE + 1n) {
          const end = start + PAGE_SIZE > head ? head : start + PAGE_SIZE;
          const logs = await publicClient.getLogs({
            address: stakedETX,
            event: REWARDS_EVENT,
            fromBlock: start,
            toBlock: end,
          });
          for (const log of logs) {
            const amount = (log.args as { amount?: bigint }).amount;
            if (amount !== undefined) {
              totalRewards += amount;
              count += 1;
            }
          }
        }

        if (cancelled) return;
        if (count === 0 || totalRewards === 0n) {
          setState({ percent: null, sampleCount: 0, loading: false, error: null });
          return;
        }

        // Approximate pre-window totalAssets.
        const pre = totalAssets > totalRewards ? totalAssets - totalRewards : 1n;
        const rewardsPct = Number(formatUnits(totalRewards, 18)) / Number(formatUnits(pre, 18));
        const apy = rewardsPct * (365 / 7) * 100;

        setState({
          percent: Number.isFinite(apy) ? apy : null,
          sampleCount: count,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          percent: null,
          sampleCount: 0,
          loading: false,
          error: err instanceof Error ? err.message : 'failed',
        });
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [publicClient, stakedETX, totalAssets]);

  return state;
}
