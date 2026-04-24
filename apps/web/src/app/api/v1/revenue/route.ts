/**
 * GET /api/v1/revenue
 *
 * Lifetime-since-launch protocol revenue report, computed from EticaSwap V2
 * Swap events across every ETX-hub pool on the factory. Surfaces:
 *
 *   - Total swap volume (ETX-denominated + USD at current anchor)
 *   - LP fees (0.30% of volume) — paid to pool LPs, not protocol revenue
 *   - **Accrued** protocol fees (0.05% of volume) — auto-minted as LP to
 *     `feeTo` by the pair's `_mintFee` hook; sitting in the multisig as
 *     LP tokens, not-yet-redeemed. Only accrues while `feeTo != 0x0`.
 *   - **Realized** protocol revenue — sum of Burn events where `to ==
 *     feeTo`, i.e. LP the treasury actually burned to pull underlying
 *     reserves into the wallet. Distinct from accrued: accrued is
 *     theoretical fees-in-LP, realized is ETX + other already in hand.
 *   - Per-pool breakdown
 *
 * Accrued and realized trend differently: accrued is monotonic (grows
 * with every swap), realized is stepwise (jumps whenever treasury
 * redeems). Net on-balance-sheet revenue = realized; "what we could
 * redeem right now" ≈ accrued.
 *
 * All numbers are computed fresh from logs on each request. Cached at
 * the Next.js layer at 60s so aggregator polls + the /status page share
 * a warm cache rather than re-scanning ~30k blocks per call.
 *
 * The pair-creation fee (`factory.pairCreationFee()`, currently 10k ETX)
 * is charged once at creation by non-trusted callers. All current pairs
 * were created by trusted creators (treasury / launchpad) so no collected
 * fees sit on the factory — we still surface the current fee parameter
 * for completeness.
 */

import { formatUnits, getAddress, type Address } from 'viem';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';
import {
  API_REVALIDATE_SECONDS,
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
  loadLifetimeSwapStats,
  loadRealizedBurnsToRecipient,
  toUnits18,
} from '@/lib/revenueApi';

export const runtime = 'nodejs';
// Tighter than API_REVALIDATE_SECONDS — per-route 60s strikes a balance
// between warm-cache efficiency for a ~30k-block scan and "since launch"
// freshness when new swaps arrive.
export const revalidate = 60;
export const dynamic = 'force-static';

const MAINNET_CHAIN_ID = 61803;
const LP_FEE_BPS = 30; // 0.30%
const PROTOCOL_FEE_BPS = 5; // 0.05% (1/6 of LP fee)
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

interface PoolRevenue {
  pool: Address;
  pairSymbol: string | null;
  otherSymbol: string | null;
  swapCount: number;
  volumeEtx: number;
  volumeUsd: number | null;
  lpFeeEtx: number;
  lpFeeUsd: number | null;
  accruedProtocolFeeEtx: number;
  accruedProtocolFeeUsd: number | null;
  realizedBurnCount: number;
  realizedEtx: number;
  realizedEtxUsd: number | null;
  realizedOther: number;
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

  // Batch the initial handshake: pairs, USD anchor, head block, factory
  // fee parameters. All independent, so a single parallel round-trip.
  const [pairs, anchors, head, feeTo, pairCreationFee] = await Promise.all([
    fetchAllPairs(client),
    fetchUsdAnchors({ nonkycApiUrl: 'https://api.nonkyc.io' }),
    client.getBlock({ blockTag: 'latest' }),
    client.readContract({
      abi: abis.factoryAbi,
      address: d.swapFactory,
      functionName: 'feeTo',
    }) as Promise<Address>,
    client.readContract({
      abi: abis.factoryAbi,
      address: d.swapFactory,
      functionName: 'pairCreationFee',
    }) as Promise<bigint>,
  ]);

  const etxUsd = await fetchAnchorEtxUsd(client, {
    factory: d.swapFactory,
    etx: d.etx,
    eti: ext.eti,
    wegaz: d.wegaz,
    anchors,
  });

  // Only ETX-hub pairs earn protocol-relevant fees. The launchpad can spawn
  // non-ETX pairs via trustedCreators, but those are outside the hub-fee
  // economy — skip them (matches /api/v1/tvl behaviour).
  const etxPairs = pairs.filter(
    (p) =>
      p.token0.toLowerCase() === etxLc || p.token1.toLowerCase() === etxLc,
  );
  const feeToActive = feeTo !== ZERO_ADDRESS;

  // Scan all ETX pairs in parallel. Cold call is ~3 pools × ~30k blocks;
  // warm hits return in <50ms once the ISR cache is seeded.
  const perPoolStats = await Promise.all(
    etxPairs.map(async (p) => {
      const etxIsToken0 = p.token0.toLowerCase() === etxLc;
      const [swapStats, realizedBurns] = await Promise.all([
        loadLifetimeSwapStats(
          p.address,
          etxIsToken0,
          head.number,
          client,
        ),
        // Skip Burn-to-feeTo scan if the factory isn't collecting fees yet
        // — there's nothing to realize. Saves an RPC round-trip per pool.
        feeToActive
          ? loadRealizedBurnsToRecipient(
              p.address,
              feeTo,
              etxIsToken0,
              DEX_LAUNCH_BLOCK,
              head.number,
              client,
            )
          : Promise.resolve({ count: 0, etxWei: 0n, otherWei: 0n }),
      ]);
      const otherAddr = etxIsToken0 ? p.token1 : p.token0;
      const otherSymbol = tokenByAddress(otherAddr)?.symbol ?? null;
      const etxSymbol = tokenByAddress(d.etx)?.symbol ?? 'ETX';
      const pairSymbol =
        otherSymbol !== null ? `${otherSymbol}/${etxSymbol}` : null;
      return {
        pair: p,
        etxIsToken0,
        swapStats,
        realizedBurns,
        pairSymbol,
        otherSymbol,
      };
    }),
  );

  let totalVolumeEtx = 0;
  let totalRealizedEtx = 0;
  const pools: PoolRevenue[] = perPoolStats.map(
    ({ pair, swapStats, realizedBurns, pairSymbol, otherSymbol }) => {
      const volumeEtx = toUnits18(swapStats.etxVolumeWei);
      totalVolumeEtx += volumeEtx;
      const lpFeeEtx = (volumeEtx * LP_FEE_BPS) / 10_000;
      const accruedProtocolFeeEtx = (volumeEtx * PROTOCOL_FEE_BPS) / 10_000;
      const realizedEtx = toUnits18(realizedBurns.etxWei);
      const realizedOther = toUnits18(realizedBurns.otherWei);
      totalRealizedEtx += realizedEtx;
      return {
        pool: getAddress(pair.address),
        pairSymbol,
        otherSymbol,
        swapCount: swapStats.swapCount,
        volumeEtx,
        volumeUsd: etxToUsd(volumeEtx, etxUsd),
        lpFeeEtx,
        lpFeeUsd: etxToUsd(lpFeeEtx, etxUsd),
        accruedProtocolFeeEtx,
        accruedProtocolFeeUsd: etxToUsd(accruedProtocolFeeEtx, etxUsd),
        realizedBurnCount: realizedBurns.count,
        realizedEtx,
        realizedEtxUsd: etxToUsd(realizedEtx, etxUsd),
        realizedOther,
      };
    },
  );

  const totalLpFeeEtx = (totalVolumeEtx * LP_FEE_BPS) / 10_000;
  const totalAccruedProtocolFeeEtx =
    (totalVolumeEtx * PROTOCOL_FEE_BPS) / 10_000;

  return jsonResponse(
    {
      chainId: MAINNET_CHAIN_ID,
      chain: 'etica-mainnet',
      asOf: new Date().toISOString(),
      etxUsd,
      launchBlock: DEX_LAUNCH_BLOCK.toString(),
      headBlock: head.number.toString(),
      // `feeTo == 0x0` means protocol fees aren't being collected on-chain;
      // the 0.05% slice shown below is what *would* accrue if turned on.
      feeTo: feeToActive ? getAddress(feeTo) : null,
      feeToActive,
      pairCreationFeeEtx: Number(formatUnits(pairCreationFee, 18)),
      swapFeeBps: LP_FEE_BPS + PROTOCOL_FEE_BPS,
      lpFeeBps: LP_FEE_BPS,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      totals: {
        swapCount: pools.reduce((acc, p) => acc + p.swapCount, 0),
        volumeEtx: totalVolumeEtx,
        volumeUsd: etxToUsd(totalVolumeEtx, etxUsd),
        lpFeeEtx: totalLpFeeEtx,
        lpFeeUsd: etxToUsd(totalLpFeeEtx, etxUsd),
        // Accrued = theoretical 0.05% slice minted as LP to feeTo but not
        // yet redeemed. Grows monotonically with swap volume.
        accruedProtocolFeeEtx: feeToActive ? totalAccruedProtocolFeeEtx : 0,
        accruedProtocolFeeUsd: feeToActive
          ? etxToUsd(totalAccruedProtocolFeeEtx, etxUsd)
          : 0,
        // Realized = actual ETX underlying pulled out of pools via
        // `pair.burn(feeTo)`. Jumps stepwise; can be 0 if the treasury
        // hasn't redeemed yet.
        realizedEtx: totalRealizedEtx,
        realizedEtxUsd: etxToUsd(totalRealizedEtx, etxUsd),
      },
      poolCount: pools.length,
      pools,
    },
    {
      headers: {
        'cache-control': `public, s-maxage=${revalidate}, stale-while-revalidate=${API_REVALIDATE_SECONDS * 2}`,
      },
    },
  );
}
