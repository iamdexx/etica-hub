/**
 * GET /api/v1/pairs/[address]/volume?window=24h
 *
 * Returns the gross per-token turnover for a single EticaSwap V2 pair over
 * a rolling time window (24h only, for now). Reads `Swap` events over the
 * last ~24h worth of blocks and sums `amountXIn + amountXOut` per token.
 *
 * Response is cached at the Next.js route layer so aggregator / UI polls
 * don't hammer the RPC — `API_REVALIDATE_SECONDS` (30s) is a good compromise
 * between freshness and RPC load on a ~5s blocktime chain.
 */

import { getAddress, isAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  VOLUME_WINDOW_24H_SECONDS,
  fetchPairByAddress,
  jsonError,
  jsonResponse,
  loadPairVolume,
  tokenByAddress,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ address: string }>;
}

export async function GET(req: Request, ctx: Context): Promise<Response> {
  const { address } = await ctx.params;
  if (!isAddress(address, { strict: false })) {
    return jsonError(400, 'invalid address');
  }
  const url = new URL(req.url);
  const windowParam = (url.searchParams.get('window') ?? '24h').toLowerCase();
  if (windowParam !== '24h') {
    return jsonError(400, 'unsupported window', {
      supported: ['24h'],
    });
  }

  const pairAddress = getAddress(address);
  const pair = await fetchPairByAddress(pairAddress);
  if (!pair) return jsonError(404, 'pair not found');

  const { summary, fromBlock, toBlock, fromTs, toTs } = await loadPairVolume(
    pairAddress,
    VOLUME_WINDOW_24H_SECONDS,
  );

  const token0 = tokenByAddress(pair.token0);
  const token1 = tokenByAddress(pair.token1);

  return jsonResponse({
    chainId: 61803,
    chain: 'etica-mainnet',
    pair: getAddress(pair.address),
    window: '24h',
    windowSeconds: VOLUME_WINDOW_24H_SECONDS,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    fromTimestamp: fromTs,
    toTimestamp: toTs,
    token0: {
      address: getAddress(pair.token0),
      symbol: token0?.symbol ?? null,
      decimals: token0?.decimals ?? null,
      volume: summary.volume0.toString(),
    },
    token1: {
      address: getAddress(pair.token1),
      symbol: token1?.symbol ?? null,
      decimals: token1?.decimals ?? null,
      volume: summary.volume1.toString(),
    },
    swapCount: summary.swapCount,
  });
}
