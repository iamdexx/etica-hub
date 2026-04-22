/**
 * GET /api/v1/pools
 *
 * CoinGecko-compatible pools endpoint. Returns the same set of pairs as
 * `/api/v1/pairs` but flattened into a shape aggregators (GeckoTerminal,
 * DEX Screener) can consume with minimal adapter code: every pool has a
 * `base` and `quote` token object with `id/symbol/address/decimals`, plus
 * a ETX-denominated spot `price` field and a stable `pool_id`.
 *
 * Where `/pairs` is opinionated about reporting everything in ETX (the hub
 * token), `/pools` keeps the pair's native orientation — `base` is always
 * `token0` and `quote` is always `token1` — so consumers can overlay their
 * own quote normalization.
 *
 * No historical volume / reserve-weighted averages yet — those wait on
 * F.12.c. The shape is forward-compatible: we'll add `volume_24h` etc.
 * alongside the current fields when the indexer ships.
 */

import { getAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  fetchAllPairs,
  jsonResponse,
  spotPriceFromReserves,
  tokenByAddress,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const pairs = await fetchAllPairs();

  const pools = pairs.map((p) => {
    const base = tokenByAddress(p.token0);
    const quote = tokenByAddress(p.token1);
    const priceBaseInQuote =
      base && quote ? spotPriceFromReserves(p, base, quote) : null;
    const priceQuoteInBase =
      base && quote ? spotPriceFromReserves(p, quote, base) : null;

    return {
      chain: 'etica-mainnet',
      chain_id: 61803,
      pool_id: `etica-mainnet_${getAddress(p.address)}`,
      pool_address: getAddress(p.address),
      dex: 'eticaswap-v2',
      base: {
        id: base?.id ?? null,
        symbol: base?.symbol ?? null,
        address: getAddress(p.token0),
        decimals: base?.decimals ?? null,
      },
      quote: {
        id: quote?.id ?? null,
        symbol: quote?.symbol ?? null,
        address: getAddress(p.token1),
        decimals: quote?.decimals ?? null,
      },
      reserves: {
        base: p.reserve0.toString(),
        quote: p.reserve1.toString(),
        block_timestamp_last: p.blockTimestampLast,
      },
      total_supply: p.totalSupply.toString(),
      price: {
        base_in_quote: priceBaseInQuote,
        quote_in_base: priceQuoteInBase,
      },
    };
  });

  return jsonResponse({
    chainId: 61803,
    chain: 'etica-mainnet',
    dex: 'eticaswap-v2',
    count: pools.length,
    pools,
  });
}
