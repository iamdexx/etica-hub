/**
 * GET /api/v1/stats
 *
 * Aggregate snapshot of the EticaSwap V2 deployment — pair count, the list
 * of assets with liquidity, the head block number, and the current ETX hub
 * token address.
 *
 * Exists as a single-call "is the protocol live?" endpoint for status
 * pages and aggregator health checks. 24h volume / TVL in USD will be
 * added once the indexer ships (F.12.c).
 */

import { getAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  apiTokens,
  fetchAllPairs,
  jsonResponse,
  priceClient,
  tokenByAddress,
} from '@/lib/priceApi';
import { DEPLOYMENTS } from '@etica-hub/shared';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-static';

const MAINNET_CHAIN_ID = 61803;

export async function GET(): Promise<Response> {
  const client = priceClient();
  const [blockNumber, pairs] = await Promise.all([
    client.getBlockNumber(),
    fetchAllPairs(client),
  ]);

  // Set of tokens that appear in at least one pair. We walk pair.token{0,1}
  // against the known-token registry so unknown (launchpad) tokens don't
  // pollute this surface — aggregators just want to see what's tradable.
  const listed = new Set<string>();
  for (const p of pairs) {
    const t0 = tokenByAddress(p.token0);
    const t1 = tokenByAddress(p.token1);
    if (t0) listed.add(t0.id);
    if (t1) listed.add(t1.id);
  }

  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];

  return jsonResponse({
    chainId: MAINNET_CHAIN_ID,
    chain: 'etica-mainnet',
    blockNumber: blockNumber.toString(),
    hubToken: {
      symbol: 'ETX',
      address: d ? getAddress(d.etx) : null,
    },
    pairCount: pairs.length,
    listedTokens: apiTokens()
      .filter((t) => listed.has(t.id))
      .map((t) => t.id),
  });
}
