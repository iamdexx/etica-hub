/**
 * GET /api/v1/simple/price?ids=eti,etx&vs_currencies=etx,egaz
 *
 * CoinGecko-compatible simple price endpoint. Accepts the same
 * `ids` + `vs_currencies` CSV params and returns the same shape:
 *
 *   {
 *     "eti": { "etx": 0.123, "egaz": 0.456 },
 *     "etx": { "etx": 1,     "egaz": 3.7 }
 *   }
 *
 * Limitations (see docs/PRICE_API.md):
 *   - No USD / fiat anchor. Aggregators that need USD supply their own
 *     reference rate and multiply.
 *   - Prices are current spot from pair reserves; there is no 24h change
 *     field until we ship the indexer (F.12.c).
 */

import {
  API_REVALIDATE_SECONDS,
  fetchAllPairs,
  jsonError,
  jsonResponse,
  priceVia,
  tokenById,
  type ApiToken,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
export const revalidate = API_REVALIDATE_SECONDS;
export const dynamic = 'force-dynamic';

function parseCsv(param: string | null, max = 32): string[] {
  if (!param) return [];
  return param
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const idsCsv = parseCsv(url.searchParams.get('ids'));
  const vsCsv = parseCsv(url.searchParams.get('vs_currencies'));
  if (idsCsv.length === 0) return jsonError(400, "missing 'ids' query param");
  if (vsCsv.length === 0) return jsonError(400, "missing 'vs_currencies' query param");

  const ids: ApiToken[] = [];
  for (const id of idsCsv) {
    const t = tokenById(id);
    if (!t) return jsonError(400, `unknown token id: ${id}`, { hint: '/api/v1/tokens lists supported ids' });
    ids.push(t);
  }
  const vs: ApiToken[] = [];
  for (const id of vsCsv) {
    const t = tokenById(id);
    if (!t) return jsonError(400, `unknown vs_currency: ${id}`, { hint: '/api/v1/tokens lists supported ids' });
    vs.push(t);
  }

  const pairs = await fetchAllPairs();

  const result: Record<string, Record<string, number | null>> = {};
  for (const base of ids) {
    const row: Record<string, number | null> = {};
    for (const quote of vs) {
      row[quote.id] = priceVia(pairs, base, quote);
    }
    result[base.id] = row;
  }

  return jsonResponse(result);
}
