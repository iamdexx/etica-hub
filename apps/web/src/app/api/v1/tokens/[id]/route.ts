/**
 * GET /api/v1/tokens/[id]
 *
 * Live per-token snapshot: total / circulating / burned supply plus spot
 * prices denominated against every other tracked token (ETX, ETI, EGAZ…).
 * Safe for aggregator polling — every field is computed from on-chain state
 * via `PublicClient` and cached at the Next.js route layer.
 */

import { getAddress } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  apiTokens,
  fetchAllPairs,
  fetchTokenSupplyStats,
  formatTokenAmount,
  jsonError,
  jsonResponse,
  priceClient,
  priceVia,
  tokenById,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-static';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await Promise.resolve(ctx.params);
  const token = tokenById(id);
  if (!token) return jsonError(404, `Unknown token id '${id}'`);

  const client = priceClient();
  const [pairs, supply] = await Promise.all([
    fetchAllPairs(client),
    fetchTokenSupplyStats(token, client),
  ]);

  const others = apiTokens().filter((t) => t.id !== token.id);
  const prices: Record<string, number | null> = {};
  for (const ref of others) {
    const p = priceVia(pairs, token, ref);
    prices[ref.id] = p;
  }

  const supplyJson = supply
    ? {
        totalSupply: supply.totalSupply.toString(),
        totalSupplyFormatted: formatTokenAmount(supply.totalSupply, token.decimals),
        circulatingSupply: supply.circulatingSupply.toString(),
        circulatingSupplyFormatted: formatTokenAmount(
          supply.circulatingSupply,
          token.decimals,
        ),
        burned: supply.burned.toString(),
        burnedFormatted: formatTokenAmount(supply.burned, token.decimals),
        excludedHolders: supply.excludedHolders,
      }
    : null;

  return jsonResponse({
    chainId: 61803,
    chain: 'etica-mainnet',
    token: {
      ...token,
      address: token.address ? getAddress(token.address) : null,
      wrappedAddress: token.wrappedAddress ? getAddress(token.wrappedAddress) : null,
    },
    supply: supplyJson,
    prices,
  });
}
