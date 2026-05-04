/**
 * GET /api/v1/liquidity-flow
 *
 * Lifetime-since-launch liquidity movement across every ETX-hub pool:
 *
 *   - Liquidity **added** (Mint events: deposits)
 *   - Liquidity **removed** (Burn events: redemptions → underlying reserves
 *     sent back to caller)
 *   - **POL burned** (LP tokens held at {BURN_ADDRESS}, i.e. permanently
 *     locked by the TreasuryHarvester via `pair.transfer(DEAD, ...)`)
 *   - Current TVL, for reconciliation against net flow
 *
 * Useful to answer "is TVL change driven by deposits/redemptions, or
 * purely price movement on the ETX leg?". A small or zero Burn count
 * combined with big TVL drift = pure price action, not outflows.
 *
 * Cached at 60s (same as /api/v1/revenue) — both scan the same block
 * window and the /status page hits them together.
 */

import { getAddress, type Address } from 'viem';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';
import {
  API_REVALIDATE_SECONDS,
  BURN_ADDRESS,
  fetchAllPairs,
  jsonResponse,
  priceClient,
  tokenByAddress,
} from '@/lib/priceApi';
import { fetchAnchorEtxUsd } from '@/lib/buybot/scan';
import { fetchUsdAnchors } from '@/lib/buybot/oracle';
import {
  DEX_LAUNCH_BLOCK,
  etxToUsd,
  fetchPolBurnedLp,
  loadLifetimeLiquidityStats,
  loadLifetimeStableswapLiquidityStats,
  toUnits18,
} from '@/lib/revenueApi';

export const runtime = 'nodejs';
export const revalidate = 60;
export const dynamic = 'force-static';

const MAINNET_CHAIN_ID = 61803;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const RATE_PRECISION = 10n ** 18n;

interface PoolLiquidityFlow {
  pool: Address;
  pairSymbol: string | null;
  etxSymbol: string;
  otherSymbol: string | null;
  /** Pool category — V2 constant-product or rate-aware stableswap. */
  kind: 'v2' | 'stableswap';
  mintCount: number;
  addedEtx: number;
  addedOther: number;
  burnCount: number;
  removedEtx: number;
  removedOther: number;
  /** Per-pool net flow on ETX side. Negative when burns outpace mints. */
  netEtx: number;
  netOther: number;
  netUsd: number | null;
  /**
   * LP balance at {BURN_ADDRESS} — not a wei ETX amount, it's LP units.
   * Convert to underlying via `lpShare * reserves` for USD context.
   * Always "0" for the stableswap pool: the treasury seed sits inside
   * `LiquidityTimelock10y`, not at DEAD, and there's no V2-style POL burn.
   */
  polLpBalance: string;
  /**
   * Current ETX-equivalent TVL.
   * - V2: 2 × ETX reserve (constant-product spot).
   * - Stableswap: reserveEtx + reserveStEtx · rate / 1e18 (live NAV).
   */
  currentTvlEtx: number;
  currentTvlUsd: number | null;
}

export async function GET(): Promise<Response> {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (!d || !ext) {
    return jsonResponse(
      { error: 'mainnet deployments unavailable' },
      { status: 500 },
    );
  }

  const client = priceClient();
  const etxLc = d.etx.toLowerCase();

  const [pairs, anchors, head] = await Promise.all([
    fetchAllPairs(client),
    fetchUsdAnchors({ nonkycApiUrl: 'https://api.nonkyc.io' }),
    client.getBlock({ blockTag: 'latest' }),
  ]);

  const etxUsd = await fetchAnchorEtxUsd(client, {
    factory: d.swapFactory,
    etx: d.etx,
    eti: ext.eti,
    wegaz: d.wegaz,
    anchors,
  });

  const etxPairs = pairs.filter(
    (p) =>
      p.token0.toLowerCase() === etxLc || p.token1.toLowerCase() === etxLc,
  );

  // Per-pool: launch→head Mint/Burn sums + current POL balance + current
  // spot TVL. All per-pool work fans out in parallel.
  const perPool = await Promise.all(
    etxPairs.map(async (p) => {
      const etxIsToken0 = p.token0.toLowerCase() === etxLc;
      const [stats, polLp] = await Promise.all([
        loadLifetimeLiquidityStats(p.address, head.number, client),
        fetchPolBurnedLp(p.address, client),
      ]);
      const otherAddr = etxIsToken0 ? p.token1 : p.token0;
      const otherSymbol = tokenByAddress(otherAddr)?.symbol ?? null;
      const etxSymbol = tokenByAddress(d.etx)?.symbol ?? 'ETX';
      const pairSymbol =
        otherSymbol !== null ? `${otherSymbol}/${etxSymbol}` : null;
      const addedEtxWei = etxIsToken0
        ? stats.mintAmount0Wei
        : stats.mintAmount1Wei;
      const addedOtherWei = etxIsToken0
        ? stats.mintAmount1Wei
        : stats.mintAmount0Wei;
      const removedEtxWei = etxIsToken0
        ? stats.burnAmount0Wei
        : stats.burnAmount1Wei;
      const removedOtherWei = etxIsToken0
        ? stats.burnAmount1Wei
        : stats.burnAmount0Wei;
      const etxReserveWei = etxIsToken0 ? p.reserve0 : p.reserve1;
      const currentTvlEtx = toUnits18(etxReserveWei) * 2;
      const addedEtx = toUnits18(addedEtxWei);
      const addedOther = toUnits18(addedOtherWei);
      const removedEtx = toUnits18(removedEtxWei);
      const removedOther = toUnits18(removedOtherWei);
      const netEtx = addedEtx - removedEtx;
      const netOther = addedOther - removedOther;
      const out: PoolLiquidityFlow = {
        pool: getAddress(p.address),
        pairSymbol,
        etxSymbol,
        otherSymbol,
        kind: 'v2',
        mintCount: stats.mintCount,
        addedEtx,
        addedOther,
        burnCount: stats.burnCount,
        removedEtx,
        removedOther,
        netEtx,
        netOther,
        netUsd: etxToUsd(netEtx, etxUsd),
        polLpBalance: polLp.toString(),
        currentTvlEtx,
        currentTvlUsd: etxToUsd(currentTvlEtx, etxUsd),
      };
      return out;
    }),
  );

  // Stableswap pool — separate event surface (AddLiquidity/RemoveLiquidity)
  // and live NAV-aware TVL (reserveEtx + reserveStEtx · rate / 1e18). Treasury
  // seed sits inside `LiquidityTimelock10y`, so per-pool POL = 0 (no DEAD burn).
  if (d.eticaStableSwap !== ZERO_ADDRESS) {
    try {
      const ss = getAddress(d.eticaStableSwap);
      const [stats, reserveEtxWei, reserveStEtxWei, rate] = await Promise.all([
        loadLifetimeStableswapLiquidityStats(ss, head.number, client),
        client.readContract({
          address: ss,
          abi: abis.eticaStableSwapAbi,
          functionName: 'reserveEtx',
        }) as Promise<bigint>,
        client.readContract({
          address: ss,
          abi: abis.eticaStableSwapAbi,
          functionName: 'reserveStEtx',
        }) as Promise<bigint>,
        client.readContract({
          address: ss,
          abi: abis.eticaStableSwapAbi,
          functionName: 'getRate',
        }) as Promise<bigint>,
      ]);
      const stEtxAsEtxWei = (reserveStEtxWei * rate) / RATE_PRECISION;
      const currentTvlEtx = toUnits18(reserveEtxWei + stEtxAsEtxWei);
      const addedEtx = toUnits18(stats.addedEtxWei);
      const addedOther = toUnits18(stats.addedStEtxWei);
      const removedEtx = toUnits18(stats.removedEtxWei);
      const removedOther = toUnits18(stats.removedStEtxWei);
      const netEtx = addedEtx - removedEtx;
      const netOther = addedOther - removedOther;
      const stEtxSymbol = tokenByAddress(d.stakedETX)?.symbol ?? 'stETX';
      const etxSymbol = tokenByAddress(d.etx)?.symbol ?? 'ETX';
      perPool.push({
        pool: ss,
        pairSymbol: `${stEtxSymbol}/${etxSymbol}`,
        etxSymbol,
        otherSymbol: stEtxSymbol,
        kind: 'stableswap',
        mintCount: stats.addCount,
        addedEtx,
        addedOther,
        burnCount: stats.removeCount,
        removedEtx,
        removedOther,
        netEtx,
        netOther,
        netUsd: etxToUsd(netEtx, etxUsd),
        polLpBalance: '0',
        currentTvlEtx,
        currentTvlUsd: etxToUsd(currentTvlEtx, etxUsd),
      });
    } catch {
      // Soft-fail: stableswap deployed but RPC hiccupped. Endpoint stays
      // up with V2-only flow; next 60s revalidate will retry.
    }
  }

  // Aggregate ETX-side flow across pools. `other` is heterogeneous by token
  // so we only sum it per-pool, not in totals — same pattern as /api/v1/tvl.
  const totals = perPool.reduce(
    (acc, p) => {
      acc.mintCount += p.mintCount;
      acc.addedEtx += p.addedEtx;
      acc.burnCount += p.burnCount;
      acc.removedEtx += p.removedEtx;
      acc.currentTvlEtx += p.currentTvlEtx;
      return acc;
    },
    { mintCount: 0, addedEtx: 0, burnCount: 0, removedEtx: 0, currentTvlEtx: 0 },
  );
  const netFlowEtx = totals.addedEtx - totals.removedEtx;

  return jsonResponse(
    {
      chainId: MAINNET_CHAIN_ID,
      chain: 'etica-mainnet',
      asOf: new Date().toISOString(),
      etxUsd,
      launchBlock: DEX_LAUNCH_BLOCK.toString(),
      headBlock: head.number.toString(),
      burnAddress: getAddress(BURN_ADDRESS),
      totals: {
        mintCount: totals.mintCount,
        addedEtx: totals.addedEtx,
        addedUsd: etxToUsd(totals.addedEtx, etxUsd),
        burnCount: totals.burnCount,
        removedEtx: totals.removedEtx,
        removedUsd: etxToUsd(totals.removedEtx, etxUsd),
        netFlowEtx,
        netFlowUsd: etxToUsd(netFlowEtx, etxUsd),
        currentTvlEtx: totals.currentTvlEtx,
        currentTvlUsd: etxToUsd(totals.currentTvlEtx, etxUsd),
      },
      poolCount: perPool.length,
      pools: perPool,
    },
    {
      headers: {
        'cache-control': `public, s-maxage=${revalidate}, stale-while-revalidate=${API_REVALIDATE_SECONDS * 2}`,
      },
    },
  );
}
