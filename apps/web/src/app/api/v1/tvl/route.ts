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
import { DEPLOYMENTS, EXTERNAL_ADDRESSES } from '@etica-hub/shared';
import { fetchAllPairs, jsonResponse, priceClient } from '@/lib/priceApi';
import { fetchAnchorEtxUsd } from '@/lib/buybot/scan';
import { fetchUsdAnchors } from '@/lib/buybot/oracle';

export const runtime = 'nodejs';
export const revalidate = 15;
export const dynamic = 'force-static';

const MAINNET_CHAIN_ID = 61803;

interface PoolTvl {
  pool: Address;
  etx: number;
  usd: number | null;
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
    });
  }

  return jsonResponse({
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
  });
}
