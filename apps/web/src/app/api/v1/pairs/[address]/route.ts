/**
 * GET /api/v1/pairs/[address]
 *
 * Detail view for a single EticaSwap V2 pair. Accepts any EIP-55 address
 * form; unknown addresses (non-pair contracts, EOAs) return 404.
 */

import { getAddress, isAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  fetchPairByAddress,
  jsonError,
  jsonResponse,
  spotPriceFromReserves,
  tokenByAddress,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-static';

interface Context {
  params: Promise<{ address: string }>;
}

export async function GET(_req: Request, ctx: Context): Promise<Response> {
  const { address } = await ctx.params;
  if (!isAddress(address, { strict: false })) {
    return jsonError(400, 'invalid address');
  }
  const pair = await fetchPairByAddress(getAddress(address));
  if (!pair) return jsonError(404, 'pair not found');

  const token0 = tokenByAddress(pair.token0);
  const token1 = tokenByAddress(pair.token1);

  // Emit both directions so a client doesn't have to know which slot
  // holds the base. `null` here means the pair contains a token we don't
  // list (launchpad-minted, etc.) and we can't tag it symbolically.
  const priceToken0InToken1 =
    token0 && token1 ? spotPriceFromReserves(pair, token0, token1) : null;
  const priceToken1InToken0 =
    token0 && token1 ? spotPriceFromReserves(pair, token1, token0) : null;

  return jsonResponse({
    chainId: 61803,
    chain: 'etica-mainnet',
    pair: {
      address: getAddress(pair.address),
      token0: {
        address: getAddress(pair.token0),
        symbol: token0?.symbol ?? null,
        decimals: token0?.decimals ?? null,
      },
      token1: {
        address: getAddress(pair.token1),
        symbol: token1?.symbol ?? null,
        decimals: token1?.decimals ?? null,
      },
      reserves: {
        reserve0: pair.reserve0.toString(),
        reserve1: pair.reserve1.toString(),
        blockTimestampLast: pair.blockTimestampLast,
      },
      totalSupply: pair.totalSupply.toString(),
      prices: {
        token0InToken1: priceToken0InToken1,
        token1InToken0: priceToken1InToken0,
      },
    },
  });
}
