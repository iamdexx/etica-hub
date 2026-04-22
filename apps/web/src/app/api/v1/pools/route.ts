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
 * Each pool also carries a `volume_24h` block with per-token gross
 * turnover + swap count for the last 24h, computed server-side by scanning
 * pair `Swap` events. The field is optional / nullable so the endpoint
 * stays responsive even if one pool's volume scan fails — clients that
 * don't care can ignore it.
 */

import { getAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  VOLUME_WINDOW_24H_SECONDS,
  fetchAllPairs,
  jsonResponse,
  loadPairVolume,
  spotPriceFromReserves,
  tokenByAddress,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const pairs = await fetchAllPairs();

  // Parallelize the per-pool volume scans; each one degrades to `null` on
  // failure so one RPC hiccup doesn't poison the whole response.
  const volumes = await Promise.all(
    pairs.map(async (p) => {
      try {
        return await loadPairVolume(getAddress(p.address), VOLUME_WINDOW_24H_SECONDS);
      } catch {
        return null;
      }
    }),
  );

  const pools = pairs.map((p, i) => {
    const base = tokenByAddress(p.token0);
    const quote = tokenByAddress(p.token1);
    const priceBaseInQuote =
      base && quote ? spotPriceFromReserves(p, base, quote) : null;
    const priceQuoteInBase =
      base && quote ? spotPriceFromReserves(p, quote, base) : null;
    const vol = volumes[i];

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
      volume_24h: vol
        ? {
            base: vol.summary.volume0.toString(),
            quote: vol.summary.volume1.toString(),
            swap_count: vol.summary.swapCount,
            from_block: vol.fromBlock.toString(),
            to_block: vol.toBlock.toString(),
            from_timestamp: vol.fromTs,
            to_timestamp: vol.toTs,
          }
        : null,
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
