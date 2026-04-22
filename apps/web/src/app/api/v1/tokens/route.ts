/**
 * GET /api/v1/tokens
 *
 * Returns the fixed set of tokens the price API currently reports on:
 * EGAZ (native), WEGAZ (its wrapper), ETX, and ETI. The list is static
 * enough that we derive it from `DEPLOYMENTS` / `EXTERNAL_ADDRESSES` at
 * request time — no RPC calls needed.
 */

import { apiTokens, API_REVALIDATE_SECONDS, jsonResponse } from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const tokens = apiTokens();
  return jsonResponse({
    chainId: 61803,
    chain: 'etica-mainnet',
    count: tokens.length,
    tokens,
  });
}
