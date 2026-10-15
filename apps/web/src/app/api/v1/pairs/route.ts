/**
 * GET /api/v1/pairs
 *
 * Returns every EticaSwap V2 hub pair plus every EticaSwap Direct (V5)
 * window with live reserves + a derived spot price. Hub pairs are quoted in
 * ETX (the hub token); Direct windows hold no ETX so they are quoted
 * token0-in-token1. `venue` tells consumers which is which.
 */

import { getAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  apiTokens,
  fetchAllDirectWindows,
  fetchAllPairs,
  jsonResponse,
  spotPriceFromReserves,
  tokenByAddress,
  type ApiToken,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const [pairs, windows] = await Promise.all([fetchAllPairs(), fetchAllDirectWindows()]);
  const tokens = apiTokens();
  const byId = new Map(tokens.map((t) => [t.id, t] as const));

  const items = [
    ...pairs.map((p) => ({ p, venue: 'hub' as const })),
    ...windows.map((p) => ({ p, venue: 'direct' as const })),
  ].map(({ p, venue }) => {
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
    if (venue === 'direct' && base && quote) {
      // Direct windows never contain ETX; quote token0 in token1 (USDC.e for
      // the dollar windows) so trackers get a usable spot straight away.
      priceInEtx = spotPriceFromReserves(p, base, quote);
      baseForPrice = base;
    } else if (etx && base && quote) {
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
      venue,
      backing: venue === 'direct' ? 'etx-hub' : 'own-reserves',
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
            quote: venue === 'direct' ? quote!.id : 'etx',
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
