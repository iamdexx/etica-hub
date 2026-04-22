'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, parseAbiItem, type Address } from 'viem';
import { useBlockNumber, usePublicClient, useReadContract } from 'wagmi';
import { abis } from '@etica-hub/shared';

/**
 * Exchange-rate history chart for stETX.
 *
 * Every call to {distributeRewards} bumps pricePerShare. We reconstruct the
 * history by reading RewardsDistributed events, computing the cumulative
 * assets-per-share after each event, and plotting. The first data point is
 * the vault's genesis state (price = 1 ETX/stETX by ERC-4626 convention) and
 * the last point is the current live rate.
 *
 * Falls back to a single "no rewards yet — rate is 1.0 ETX/stETX" line when
 * no events have been emitted yet.
 */

const LOOKBACK_BLOCKS = 250_000n; // ~14 days at 5s blocktime
const PAGE_SIZE = 10_000n;
const ETICA_BLOCKTIME_S = 5;
const REWARDS_EVENT = parseAbiItem(
  'event RewardsDistributed(address indexed from, uint256 amount)',
);

interface RatePoint {
  ts: number; // unix seconds
  rate: number; // ETX per stETX
}

interface StakeRateChartProps {
  stakedETX: Address;
}

export function StakeRateChart({ stakedETX }: StakeRateChartProps) {
  const publicClient = usePublicClient();
  const { data: blockNumber } = useBlockNumber({ watch: false });

  // Live stats for the rightmost data point.
  const totalAssetsQuery = useReadContract({
    abi: abis.stakedEtxAbi,
    address: stakedETX,
    functionName: 'totalAssets',
    query: { refetchInterval: 30_000 },
  });
  const totalSupplyQuery = useReadContract({
    abi: abis.stakedEtxAbi,
    address: stakedETX,
    functionName: 'totalSupply',
    query: { refetchInterval: 30_000 },
  });

  const liveRate = useMemo<number | null>(() => {
    const a = totalAssetsQuery.data as bigint | undefined;
    const s = totalSupplyQuery.data as bigint | undefined;
    if (a === undefined || s === undefined) return null;
    if (s === 0n) return 1;
    return Number(formatUnits(a, 18)) / Number(formatUnits(s, 18));
  }, [totalAssetsQuery.data, totalSupplyQuery.data]);

  const [points, setPoints] = useState<RatePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const lastBlockFetched = useRef<bigint | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      // Gate on liveRate too: without it the reconstructed series would
      // anchor against a stale `1.0` value. Because useBlockNumber runs
      // with `watch: false`, head never changes, so an early run before
      // liveRate resolves would set lastBlockFetched.current=head and the
      // guard below would permanently skip every subsequent render.
      if (!publicClient || !blockNumber || liveRate === null) return;
      const head = blockNumber;
      if (lastBlockFetched.current === head) return;
      lastBlockFetched.current = head;
      setLoading(true);
      setErr(null);

      try {
        const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
        const rewards: { block: bigint; amount: bigint }[] = [];
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
            if (amount !== undefined && log.blockNumber !== null) {
              rewards.push({ block: log.blockNumber, amount });
            }
          }
        }

        // Resolve current time for the head block; walk backwards by blocktime
        // for each event (avoids an eth_getBlockByNumber per log).
        const headBlock = await publicClient.getBlock({ blockNumber: head });
        const headTs = Number(headBlock.timestamp);

        // We need totalSupply() frozen at the moment of each reward to reason
        // about the rate. Since deposits/withdraws don't change the rate,
        // the rate right after a reward is simply (cumulativeAssets / shares_now).
        // For a clean chart we instead plot (assetsGrowth / sharesNow) anchored
        // against the live current point — which gives a monotonically
        // non-decreasing curve. Concretely:
        //   rate(t) = liveRate - (sum_of_rewards_after_t / totalSupply_now)
        // This is exact if totalSupply is constant after t (reasonable for a
        // short window and good enough for a visual curve; the indexer path
        // can do it exactly once we ship aggregated candles).
        const supplyNow = (totalSupplyQuery.data as bigint | undefined) ?? 0n;
        const supplyNowF = supplyNow > 0n ? Number(formatUnits(supplyNow, 18)) : 1;
        const live = liveRate ?? 1;

        const series: RatePoint[] = [];
        // Sort oldest→newest, accumulate suffix sums from the end.
        rewards.sort((a, b) => Number(a.block - b.block));
        // Build suffix sums: suffixRewards[i] = sum of rewards[i..]
        const suffix: number[] = new Array(rewards.length + 1).fill(0);
        for (let i = rewards.length - 1; i >= 0; i--) {
          suffix[i] = suffix[i + 1] + Number(formatUnits(rewards[i].amount, 18));
        }
        for (let i = 0; i < rewards.length; i++) {
          const deltaBlocks = Number(head - rewards[i].block);
          const ts = headTs - deltaBlocks * ETICA_BLOCKTIME_S;
          const rateAt = live - suffix[i] / supplyNowF;
          series.push({ ts, rate: rateAt });
        }
        // Anchor the live point.
        series.push({ ts: headTs, rate: live });

        if (cancelled) return;
        setPoints(series);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'failed');
        setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [publicClient, blockNumber, stakedETX, liveRate, totalSupplyQuery.data]);

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-white">Exchange rate (last ~14 days)</h3>
        <span className="text-xs text-white/40">
          {loading ? 'loading…' : err ? 'error' : `${points.length} pts`}
        </span>
      </div>
      <RateSvg points={points} />
      {points.length <= 1 && !loading && (
        <div className="mt-2 text-xs text-white/50">
          No rewards distributed yet. Exchange rate starts at 1.0 ETX / stETX and only
          moves up when the keeper calls{' '}
          <span className="font-mono">distributeRewards()</span>.
        </div>
      )}
    </section>
  );
}

function RateSvg({ points }: { points: RatePoint[] }) {
  const width = 640;
  const height = 180;
  const padding = { top: 10, right: 10, bottom: 20, left: 48 };

  if (points.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center text-xs text-white/40">
        No data.
      </div>
    );
  }

  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.rate);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = Math.max(xMax - xMin, 1);
  const ySpan = Math.max(yMax - yMin, 1e-9);

  const toX = (x: number) =>
    padding.left + ((x - xMin) / xSpan) * (width - padding.left - padding.right);
  const toY = (y: number) =>
    height - padding.bottom - ((y - yMin) / ySpan) * (height - padding.top - padding.bottom);

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.ts).toFixed(1)},${toY(p.rate).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke="rgba(255,255,255,0.1)"
      />
      <line
        x1={padding.left}
        y1={padding.top}
        x2={padding.left}
        y2={height - padding.bottom}
        stroke="rgba(255,255,255,0.1)"
      />
      <text
        x={4}
        y={padding.top + 10}
        fontSize="10"
        fill="rgba(255,255,255,0.5)"
        fontFamily="monospace"
      >
        {yMax.toFixed(6)}
      </text>
      <text
        x={4}
        y={height - padding.bottom}
        fontSize="10"
        fill="rgba(255,255,255,0.5)"
        fontFamily="monospace"
      >
        {yMin.toFixed(6)}
      </text>
      <path d={d} fill="none" stroke="#4ade80" strokeWidth="1.5" />
    </svg>
  );
}
