/**
 * GET /api/v1/ohlcv/{pair}?interval=1h&limit=100&base=etx
 *
 * OHLC candle history for an EticaSwap V2 pair, derived on the fly from
 * `Sync(uint112, uint112)` event logs. Returns candles in ascending time
 * order; the newest candle is the partially-closed current bucket.
 *
 * This exists so DEX Screener / GeckoTerminal — which both ask for at
 * least short-range candle history before they'll index a chain — have a
 * stable URL to pull from without us running an indexer. Short ranges
 * (last ~100 × 1h candles) are cheap; deeper history still waits on
 * F.12.c.
 *
 * Query params
 *   - `interval`: one of `5m | 15m | 1h | 4h | 1d`. Default `1h`.
 *   - `limit`:    candles to return, 1 ≤ limit ≤ 500. Default 100.
 *   - `base`:     token id (see /api/v1/tokens) to price. Optional —
 *                 defaults to the non-ETX side of the pair, falling back to
 *                 `token0` when both sides are unknown to the registry.
 *
 * Response
 *   {
 *     "pair": "0x…",
 *     "base": "eti", "quote": "etx",
 *     "interval": "1h", "intervalSeconds": 3600,
 *     "fromBlock": "…", "toBlock": "…",
 *     "candles": [{ "t": …, "o": …, "h": …, "l": …, "c": …, "samples": N }, …]
 *   }
 */

import { getAddress, isAddress, type Address, type PublicClient } from 'viem';
import {
  API_REVALIDATE_SECONDS,
  ETICA_AVG_BLOCKTIME_SECONDS,
  OHLCV_DEFAULT_CANDLES,
  OHLCV_INTERVALS,
  OHLCV_MAX_CANDLES,
  aggregateCandles,
  fetchPairByAddress,
  fetchSyncLogs,
  jsonError,
  jsonResponse,
  priceClient,
  spotPriceFromReserves,
  tokenByAddress,
  tokenById,
  type ApiPairRaw,
  type ApiToken,
  type OhlcvInterval,
  type SyncSample,
} from '@/lib/priceApi';

export const runtime = 'nodejs';
// One minute — OHLCV is much more expensive to compute than spot, and
// clients can poll `/api/v1/pairs` for the latest tick between buckets.
export const revalidate = 60;
export const dynamic = 'force-dynamic';

function parseInterval(raw: string | null): OhlcvInterval | null {
  if (raw == null) return '1h';
  const needle = raw.trim().toLowerCase();
  if (needle in OHLCV_INTERVALS) return needle as OhlcvInterval;
  return null;
}

function parseLimit(raw: string | null): number | null {
  if (raw == null) return OHLCV_DEFAULT_CANDLES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, OHLCV_MAX_CANDLES);
}

function chooseBase(pair: ApiPairRaw, explicit: ApiToken | null): ApiToken | null {
  if (explicit) return explicit;
  const t0 = tokenByAddress(pair.token0);
  const t1 = tokenByAddress(pair.token1);
  // Prefer the non-ETX side so ETI/ETX pairs render "ETI in ETX" by default.
  if (t0 && t0.id !== 'etx') return t0;
  if (t1 && t1.id !== 'etx') return t1;
  return t0 ?? t1 ?? null;
}

/**
 * True if `token` on-chain is the requested `base` for quoting purposes.
 *
 * EGAZ is the native coin (no address, just a `wrappedAddress` pointing at
 * WEGAZ) while WEGAZ is the matching ERC-20 wrapper. A pair on-chain only
 * ever contains WEGAZ, but callers are welcome to ask `?base=egaz` — we
 * treat the two as interchangeable for side-matching so that request
 * doesn't spuriously 400.
 */
function isSameSide(token: ApiToken | null, base: ApiToken): boolean {
  if (!token) return false;
  if (token.id === base.id) return true;
  if (base.id === 'egaz' && token.id === 'wegaz') return true;
  if (base.id === 'wegaz' && token.id === 'egaz') return true;
  return false;
}

function otherSide(pair: ApiPairRaw, base: ApiToken): ApiToken | null {
  const t0 = tokenByAddress(pair.token0);
  const t1 = tokenByAddress(pair.token1);
  if (isSameSide(t0, base)) return t1;
  if (isSameSide(t1, base)) return t0;
  return null;
}

async function estimateBlockWindow(
  client: PublicClient,
  intervalSeconds: number,
  limit: number,
): Promise<{ fromBlock: bigint; toBlock: bigint; fromTs: number; toTs: number }> {
  const head = await client.getBlock({ blockTag: 'latest' });
  const toTs = Number(head.timestamp);
  const toBlock = head.number;
  const windowSeconds = intervalSeconds * limit;
  const approxBlocks = BigInt(Math.ceil(windowSeconds / ETICA_AVG_BLOCKTIME_SECONDS));
  const fromBlock = toBlock > approxBlocks ? toBlock - approxBlocks : 0n;
  const fromTs = toTs - windowSeconds;
  return { fromBlock, toBlock, fromTs, toTs };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ pair: string }> },
): Promise<Response> {
  const { pair: pairParam } = await ctx.params;
  if (!isAddress(pairParam, { strict: false })) {
    return jsonError(400, "invalid pair address", { hint: "must be 20-byte hex" });
  }
  const pairAddress = getAddress(pairParam) as Address;

  const url = new URL(req.url);
  const interval = parseInterval(url.searchParams.get('interval'));
  if (!interval) {
    return jsonError(400, 'unknown interval', {
      hint: `supported: ${Object.keys(OHLCV_INTERVALS).join(', ')}`,
    });
  }
  const intervalSeconds = OHLCV_INTERVALS[interval];

  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit == null) {
    return jsonError(400, 'invalid limit', { hint: `1-${OHLCV_MAX_CANDLES}` });
  }

  const baseIdRaw = url.searchParams.get('base');
  let explicitBase: ApiToken | null = null;
  if (baseIdRaw) {
    explicitBase = tokenById(baseIdRaw);
    if (!explicitBase) {
      return jsonError(400, `unknown base token id: ${baseIdRaw}`, {
        hint: '/api/v1/tokens lists supported ids',
      });
    }
  }

  const client = priceClient();
  const pair = await fetchPairByAddress(pairAddress, client);
  if (!pair) return jsonError(404, 'pair not found on factory');

  const base = chooseBase(pair, explicitBase);
  if (!base) {
    return jsonError(400, 'could not infer base token for pair', {
      hint: 'pass ?base=etx|eti|egaz|wegaz',
    });
  }
  const quote = otherSide(pair, base);
  if (!quote) {
    return jsonError(400, 'pair does not contain the requested base token');
  }

  const { fromBlock, toBlock, fromTs, toTs } = await estimateBlockWindow(client, intervalSeconds, limit);

  const logs = await fetchSyncLogs(pairAddress, fromBlock, toBlock, client);

  // Turn each Sync into a (timestamp, price) sample. When a log carries no
  // blockNumber (some providers strip it under load) we fall back to the
  // head block — that bucket just ends up in the newest candle.
  const samples: SyncSample[] = logs
    .map((log) => {
      const synthetic: ApiPairRaw = {
        address: pair.address,
        token0: pair.token0,
        token1: pair.token1,
        reserve0: log.reserve0,
        reserve1: log.reserve1,
        blockTimestampLast: 0,
        totalSupply: 0n,
      };
      const price = spotPriceFromReserves(synthetic, base, quote);
      if (price == null) return null;
      const bn = log.blockNumber ?? toBlock;
      // Approximate timestamp: head_ts − (head_block − bn) × blocktime.
      const deltaBlocks = Number(toBlock - bn);
      const ts = toTs - deltaBlocks * ETICA_AVG_BLOCKTIME_SECONDS;
      return { timestamp: ts, price };
    })
    .filter((s): s is SyncSample => s !== null);

  const candles = aggregateCandles(samples, intervalSeconds, fromTs, toTs).slice(-limit);

  return jsonResponse({
    chainId: 61803,
    chain: 'etica-mainnet',
    pair: pairAddress,
    base: base.id,
    quote: quote.id,
    interval,
    intervalSeconds,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    fromTs,
    toTs,
    count: candles.length,
    candles,
    notes: [
      'Candles derived from Sync events; sample count is included but volume is not yet tracked (F.12.c).',
      `Timestamps are estimated using ${ETICA_AVG_BLOCKTIME_SECONDS}s blocktime and are accurate to within one block.`,
    ],
  });
}
