/**
 * GET /api/v1/pairs
 *
 * Returns every EticaSwap V2 pair registered on the factory with live
 * reserves + a derived spot price quoted in ETX (the hub token). Useful
 * for third-party dashboards that want a single snapshot of the DEX.
 */

import { getAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  apiTokens,
  fetchAllPairs,
  jsonResponse,
  spotPriceFromReserves,
  tokenByAddress,
  type ApiToken,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const pairs = await fetchAllPairs();
  const tokens = apiTokens();
  const byId = new Map(tokens.map((t) => [t.id, t] as const));

  const items = pairs.map((p) => {
    const base = tokenByAddress(p.token0);
    const quote = tokenByAddress(p.token1);
    // When a pair references a token we don't know (launchpad-minted, etc.),
    // we still emit the raw pair data but leave symbols blank.
    const baseSymbol = base?.symbol ?? null;
    const quoteSymbol = quote?.symbol ?? null;

    // Quote every pair in ETX where possible — it's the hub token and the
    // cleanest common denominator for third-party consumers.
    const etx = byId.get('etx') ?? null;
    let priceInEtx: number | null = null;
    let baseForPrice: ApiToken | null = null;
    if (etx && base && quote) {
      if (base.id === 'etx') {
        // ETX is token0; price = quote amount per 1 ETX.
        priceInEtx = null;
        baseForPrice = quote;
        const reversed = spotPriceFromReserves(p, quote, etx);
        if (reversed != null) priceInEtx = reversed;
      } else if (quote.id === 'etx') {
        priceInEtx = spotPriceFromReserves(p, base, etx);
        baseForPrice = base;
      }
    }

    return {
      address: getAddress(p.address),
      token0: {
        address: getAddress(p.token0),
        symbol: baseSymbol,
      },
      token1: {
        address: getAddress(p.token1),
        symbol: quoteSymbol,
      },
      reserves: {
        reserve0: p.reserve0.toString(),
        reserve1: p.reserve1.toString(),
        blockTimestampLast: p.blockTimestampLast,
      },
      totalSupply: p.totalSupply.toString(),
      price: baseForPrice && priceInEtx != null
        ? {
            base: baseForPrice.id,
            quote: 'etx',
            value: priceInEtx,
          }
        : null,
    };
  });

  return jsonResponse({
    chainId: 61803,
    chain: 'etica-mainnet',
    count: items.length,
    pairs: items,
  });
}
