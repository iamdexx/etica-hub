/**
 * GET /api/v1/tvl
 *
 * Live total value locked across every EticaSwap V2 pool, denominated in
 * both ETX (the hub token) and USD. Computed from on-chain reserves at the
 * latest block — no indexer dependency, no historical buffering.
 *
 * For each pool we count 2 × (ETX-side reserve), which is the standard
 * constant-product TVL measure at spot equilibrium: the non-ETX leg is
 * always worth exactly the ETX leg when priced through the pool's own
 * curve. Summing across pools gives total DEX TVL in ETX.
 *
 * USD is derived by routing ETX through an anchor pool (ETX/WEGAZ
 * preferred, ETX/ETI fallback) and multiplying by the matching NonKYC
 * USDT quote. If neither anchor has liquidity or NonKYC is unreachable,
 * `usd` is `null` so the UI can render "—" instead of showing stale or
 * fabricated numbers.
 *
 * Cached briefly at the edge so aggregator polls don't hammer the RPC;
 * the banner on /swap polls every 15s and the cache window matches.
 */

import { formatUnits, getAddress, type Address } from 'viem';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';
import { fetchAllPairs, jsonResponse, priceClient } from '@/lib/priceApi';
import { fetchAnchorEtxUsd } from '@/lib/buybot/scan';
import { fetchUsdAnchors } from '@/lib/buybot/oracle';

export const runtime = 'nodejs';
export const revalidate = 15;
export const dynamic = 'force-static';

const MAINNET_CHAIN_ID = 61803;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const PRECISION = 10n ** 18n;

interface PoolTvl {
  pool: Address;
  etx: number;
  usd: number | null;
  /** Pool category — V2 constant-product or rate-aware stableswap. */
  kind?: 'v2' | 'stableswap';
}

export async function GET(): Promise<Response> {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (!d || !ext) {
    return jsonResponse({ error: 'mainnet deployments unavailable' }, { status: 500 });
  }

  const client = priceClient();

  // Reserve snapshot for every ETX-hub pool + USDT anchors in parallel.
  const [pairs, anchors] = await Promise.all([
    fetchAllPairs(client),
    fetchUsdAnchors({ nonkycApiUrl: 'https://api.nonkyc.io' }),
  ]);

  const etxUsd = await fetchAnchorEtxUsd(client, {
    factory: d.swapFactory,
    etx: d.etx,
    eti: ext.eti,
    wegaz: d.wegaz,
    anchors,
  });

  const etxLc = d.etx.toLowerCase();
  let tvlEtx = 0;
  const poolBreakdown: PoolTvl[] = [];
  for (const p of pairs) {
    const t0 = p.token0.toLowerCase();
    const t1 = p.token1.toLowerCase();
    // The factory lets `trustedCreators` (e.g. the launchpad) spawn pairs
    // without ETX, so hub-and-spoke isn't universal. Skip any non-ETX pair
    // — otherwise we'd treat an unrelated token's reserve as ETX.
    if (t0 !== etxLc && t1 !== etxLc) continue;
    const etxWei = t0 === etxLc ? p.reserve0 : p.reserve1;
    if (etxWei === 0n) continue;
    // Every current hub-and-spoke token on Etica is 18 decimals, which is
    // also ETX's own decimals. Safe to format at 18.
    const etxUnits = Number(formatUnits(etxWei, 18));
    const poolEtx = etxUnits * 2;
    tvlEtx += poolEtx;
    poolBreakdown.push({
      pool: getAddress(p.address),
      etx: poolEtx,
      usd: etxUsd !== null ? poolEtx * etxUsd : null,
      kind: 'v2',
    });
  }

  // Stableswap pool isn't in the V2 factory — it's a standalone contract.
  // Read its reserves + live NAV directly so the TVL banner reflects the
  // ~30M ETX-equivalent seed (and any subsequent public LP additions).
  // ETX-equivalent of stETX = reserveStEtx · rate / 1e18, where
  //   rate = stETX.convertToAssets(1e18). Total stableswap TVL in ETX is
  // reserveEtx + ETX-equivalent(reserveStEtx). No constant-product ×2
  // shortcut here: the pool is not at 50/50 by reserves, the two legs are
  // priced 1:1 in ETX-equivalent terms only after applying the live rate.
  if (d.eticaStableSwap !== ZERO_ADDRESS) {
    try {
      const [reserveEtxRaw, reserveStEtxRaw, rate] = await Promise.all([
        client.readContract({
          abi: abis.eticaStableSwapAbi,
          address: d.eticaStableSwap,
          functionName: 'reserveEtx',
        }) as Promise<bigint>,
        client.readContract({
          abi: abis.eticaStableSwapAbi,
          address: d.eticaStableSwap,
          functionName: 'reserveStEtx',
        }) as Promise<bigint>,
        client.readContract({
          abi: abis.eticaStableSwapAbi,
          address: d.eticaStableSwap,
          functionName: 'getRate',
        }) as Promise<bigint>,
      ]);
      const stEtxInEtx = (reserveStEtxRaw * rate) / PRECISION;
      const totalEtxWei = reserveEtxRaw + stEtxInEtx;
      const poolEtx = Number(formatUnits(totalEtxWei, 18));
      if (poolEtx > 0) {
        tvlEtx += poolEtx;
        poolBreakdown.push({
          pool: getAddress(d.eticaStableSwap),
          etx: poolEtx,
          usd: etxUsd !== null ? poolEtx * etxUsd : null,
          kind: 'stableswap',
        });
      }
    } catch {
      // RPC failure on the stableswap reads should not zero out the V2
      // half of TVL — fall through and return the V2-only number rather
      // than 500ing the whole endpoint. Aggregator clients then see a
      // briefly-undercount TVL instead of a hard error.
    }
  }

  return jsonResponse(
    {
      chainId: MAINNET_CHAIN_ID,
      chain: 'etica-mainnet',
      asOf: new Date().toISOString(),
      etxUsd,
      tvl: {
        etx: tvlEtx,
        usd: etxUsd !== null ? tvlEtx * etxUsd : null,
      },
      poolCount: poolBreakdown.length,
      pools: poolBreakdown,
    },
    {
      // Align downstream cache-control with the route's 15s revalidate so
      // CDNs serving aggregator polls don't outlive the ISR window and
      // return data twice as stale as intended.
      headers: {
        'cache-control': `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate * 2}`,
      },
    },
  );
}
