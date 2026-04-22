/**
 * GET /api/v1/supply/{stat}?token=etx
 *
 * Plain-text single-number endpoints tailored for CoinGecko / CoinMarketCap
 * listing forms. Each aggregator asks for a public URL that returns the
 * project's supply as a single number — this is that URL.
 *
 * Supported `stat` path segments:
 *   - `total`        → totalSupply()
 *   - `circulating`  → totalSupply - balances held at excluded addresses
 *   - `burned`       → balanceOf(0x…dEaD)
 *
 * Optional `?token=<id>` query param (defaults to `etx`) selects which
 * tracked token to report on. Unknown ids and native tokens (EGAZ) return
 * HTTP 404 / 400 respectively.
 */

import {
  API_REVALIDATE_SECONDS,
  fetchTokenSupplyStats,
  formatTokenAmount,
  priceClient,
  tokenById,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-dynamic';

const SUPPORTED_STATS = ['total', 'circulating', 'burned'] as const;
type SupplyStat = (typeof SUPPORTED_STATS)[number];

function isSupportedStat(s: string): s is SupplyStat {
  return (SUPPORTED_STATS as readonly string[]).includes(s);
}

const TEXT_HEADERS: HeadersInit = {
  'content-type': 'text/plain; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': `public, s-maxage=${API_REVALIDATE_SECONDS}, stale-while-revalidate=${API_REVALIDATE_SECONDS * 2}`,
};

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: TEXT_HEADERS });
}

interface RouteContext {
  params: Promise<{ stat: string }> | { stat: string };
}

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { stat } = await Promise.resolve(ctx.params);
  if (!isSupportedStat(stat)) {
    return textResponse(
      `unsupported stat '${stat}' (expected one of ${SUPPORTED_STATS.join(', ')})`,
      400,
    );
  }

  const url = new URL(req.url);
  const rawTokenId = url.searchParams.get('token') ?? 'etx';
  const token = tokenById(rawTokenId);
  if (!token) return textResponse(`unknown token '${rawTokenId}'`, 404);
  if (!token.address) {
    return textResponse(
      `supply endpoints are only valid for ERC-20 tokens (got '${token.id}')`,
      400,
    );
  }

  const supply = await fetchTokenSupplyStats(token, priceClient());
  if (!supply) return textResponse(`no supply data for '${token.id}'`, 500);

  const raw =
    stat === 'total'
      ? supply.totalSupply
      : stat === 'circulating'
        ? supply.circulatingSupply
        : supply.burned;

  return textResponse(formatTokenAmount(raw, token.decimals));
}
