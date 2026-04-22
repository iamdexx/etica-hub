import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  aggregateCandles,
  apiTokens,
  headBlockAgeSeconds,
  OHLCV_INTERVALS,
  priceVia,
  spotPriceFromReserves,
  tokenByAddress,
  tokenById,
  type ApiPairRaw,
  type ApiToken,
  type SyncSample,
} from '../src/lib/priceApi';

// These addresses mirror `packages/shared/src/addresses.ts` entry for chain
// 61803. Keeping them in-test rather than re-exporting from the registry
// means the tests fail loudly if the registry changes shape.
const ETX = '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044' as Address;
const WEGAZ = '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a' as Address;
const ETI = '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as Address;

function tok(id: string): ApiToken {
  const t = tokenById(id);
  if (!t) throw new Error(`missing ${id}`);
  return t;
}

function mkPair(
  addr: string,
  token0: Address,
  token1: Address,
  reserve0: bigint,
  reserve1: bigint,
): ApiPairRaw {
  return {
    address: addr as Address,
    token0,
    token1,
    reserve0,
    reserve1,
    blockTimestampLast: 0,
    totalSupply: 0n,
  };
}

describe('apiTokens', () => {
  it('returns the canonical 4-token set', () => {
    const ids = apiTokens().map((t) => t.id).sort();
    expect(ids).toEqual(['egaz', 'eti', 'etx', 'wegaz']);
  });

  it('flags EGAZ as native and WEGAZ as its wrapped partner', () => {
    const egaz = tok('egaz');
    const wegaz = tok('wegaz');
    expect(egaz.isNative).toBe(true);
    expect(egaz.address).toBeNull();
    expect(egaz.wrappedAddress && getAddress(egaz.wrappedAddress)).toBe(getAddress(WEGAZ));
    expect(wegaz.isNative).toBe(false);
    expect(wegaz.address && getAddress(wegaz.address)).toBe(getAddress(WEGAZ));
  });

  it('all tokens use 18 decimals on Etica mainnet', () => {
    for (const t of apiTokens()) expect(t.decimals).toBe(18);
  });
});

describe('tokenById / tokenByAddress', () => {
  it('is case-insensitive on id', () => {
    expect(tokenById('ETX')?.id).toBe('etx');
    expect(tokenById('etx')?.id).toBe('etx');
  });

  it('returns null on unknown id', () => {
    expect(tokenById('doge')).toBeNull();
  });

  it('resolves by checksummed + lowercased address', () => {
    expect(tokenByAddress(ETX)?.id).toBe('etx');
    expect(tokenByAddress(ETX.toLowerCase())?.id).toBe('etx');
    expect(tokenByAddress(ETI)?.id).toBe('eti');
    expect(tokenByAddress('0x0000000000000000000000000000000000000000')).toBeNull();
  });

  it('returns null for malformed addresses instead of throwing', () => {
    expect(tokenByAddress('not-an-address')).toBeNull();
  });
});

describe('spotPriceFromReserves', () => {
  it('returns quote/base when base == token0', () => {
    // 1000 ETI : 500 ETX  =>  price(ETI in ETX) = 0.5
    const pair = mkPair(
      '0x1111111111111111111111111111111111111111',
      ETI,
      ETX,
      1000n * 10n ** 18n,
      500n * 10n ** 18n,
    );
    const price = spotPriceFromReserves(pair, tok('eti'), tok('etx'));
    expect(price).toBeCloseTo(0.5, 12);
  });

  it('returns quote/base when base == token1 (orientation flipped)', () => {
    // same reserves but with ETX in token0 slot
    const pair = mkPair(
      '0x2222222222222222222222222222222222222222',
      ETX,
      ETI,
      500n * 10n ** 18n,
      1000n * 10n ** 18n,
    );
    const price = spotPriceFromReserves(pair, tok('eti'), tok('etx'));
    expect(price).toBeCloseTo(0.5, 12);
  });

  it('returns null when the pair does not contain both tokens', () => {
    const pair = mkPair(
      '0x3333333333333333333333333333333333333333',
      ETX,
      WEGAZ,
      100n,
      100n,
    );
    const price = spotPriceFromReserves(pair, tok('eti'), tok('etx'));
    expect(price).toBeNull();
  });

  it('returns null when either reserve is zero (empty pool)', () => {
    const pair = mkPair(
      '0x4444444444444444444444444444444444444444',
      ETI,
      ETX,
      0n,
      100n * 10n ** 18n,
    );
    expect(spotPriceFromReserves(pair, tok('eti'), tok('etx'))).toBeNull();
  });

  it('uses the WEGAZ address to price native EGAZ', () => {
    const pair = mkPair(
      '0x5555555555555555555555555555555555555555',
      WEGAZ,
      ETX,
      2n * 10n ** 18n,
      20n * 10n ** 18n,
    );
    // 2 WEGAZ : 20 ETX  =>  price(EGAZ in ETX) = 10
    const price = spotPriceFromReserves(pair, tok('egaz'), tok('etx'));
    expect(price).toBeCloseTo(10, 12);
  });
});

describe('priceVia', () => {
  it('returns 1 for identity pricing', () => {
    expect(priceVia([], tok('etx'), tok('etx'))).toBe(1);
  });

  it('treats EGAZ and WEGAZ as 1:1 without hitting any pair', () => {
    expect(priceVia([], tok('egaz'), tok('wegaz'))).toBe(1);
    expect(priceVia([], tok('wegaz'), tok('egaz'))).toBe(1);
  });

  it('prefers a direct pool when one exists', () => {
    const direct = mkPair(
      '0x6666666666666666666666666666666666666666',
      ETI,
      ETX,
      1000n * 10n ** 18n,
      500n * 10n ** 18n,
    );
    const price = priceVia([direct], tok('eti'), tok('etx'));
    expect(price).toBeCloseTo(0.5, 12);
  });

  it('one-hops via ETX when there is no direct pool', () => {
    // ETI/ETX: 1000:500 => price(ETI in ETX) = 0.5
    // ETX/WEGAZ: 100:50 => price(ETX in WEGAZ) = 0.5
    // => price(ETI in EGAZ via ETX) = 0.25
    const etiEtx = mkPair(
      '0x7777777777777777777777777777777777777777',
      ETI,
      ETX,
      1000n * 10n ** 18n,
      500n * 10n ** 18n,
    );
    const etxWegaz = mkPair(
      '0x8888888888888888888888888888888888888888',
      ETX,
      WEGAZ,
      100n * 10n ** 18n,
      50n * 10n ** 18n,
    );
    const price = priceVia([etiEtx, etxWegaz], tok('eti'), tok('egaz'));
    expect(price).toBeCloseTo(0.25, 12);
  });

  it('returns null when neither a direct pool nor an ETX hop exists', () => {
    // Only ETI/ETX present; asking for ETI→EGAZ with no ETX→WEGAZ pool.
    const etiEtx = mkPair(
      '0x9999999999999999999999999999999999999999',
      ETI,
      ETX,
      1000n * 10n ** 18n,
      500n * 10n ** 18n,
    );
    expect(priceVia([etiEtx], tok('eti'), tok('egaz'))).toBeNull();
  });
});

describe('OHLCV_INTERVALS', () => {
  it('exposes the canonical 5m/15m/1h/4h/1d set', () => {
    expect(Object.keys(OHLCV_INTERVALS).sort()).toEqual(
      ['15m', '1d', '1h', '4h', '5m'].sort(),
    );
  });
  it('uses seconds as the unit', () => {
    expect(OHLCV_INTERVALS['1h']).toBe(3600);
    expect(OHLCV_INTERVALS['1d']).toBe(86400);
  });
});

describe('aggregateCandles', () => {
  // All timestamps below are seconds and align to fixed buckets so the math
  // stays obvious. Interval is 1m (60s) unless noted.

  const INTERVAL = 60;

  function sample(timestamp: number, price: number): SyncSample {
    return { timestamp, price };
  }

  it('returns an empty array when from > to', () => {
    expect(aggregateCandles([], INTERVAL, 120, 60)).toEqual([]);
  });

  it('drops leading empty buckets with no prior sample', () => {
    // One sample in the last bucket, no baseline — first two buckets are
    // silently dropped rather than invented.
    const candles = aggregateCandles(
      [sample(180, 5)],
      INTERVAL,
      60, // first-bucket start: 60
      180, // last-bucket start: 180
    );
    expect(candles).toEqual([
      { t: 180, o: 5, h: 5, l: 5, c: 5, samples: 1 },
    ]);
  });

  it('buckets multiple samples into a single candle with correct OHLC', () => {
    const candles = aggregateCandles(
      [
        sample(60, 10),
        sample(80, 20),
        sample(100, 5),
        sample(119, 15),
      ],
      INTERVAL,
      60,
      60,
    );
    expect(candles).toEqual([
      { t: 60, o: 10, h: 20, l: 5, c: 15, samples: 4 },
    ]);
  });

  it('carries previous close into empty buckets', () => {
    // Sample at t=60 then nothing until t=240 — the intermediate buckets
    // should inherit the 7.0 close as flat doji candles.
    const candles = aggregateCandles(
      [sample(60, 7), sample(240, 12)],
      INTERVAL,
      60,
      240,
    );
    expect(candles.map((c) => [c.t, c.o, c.c, c.samples])).toEqual([
      [60, 7, 7, 1],
      [120, 7, 7, 0],
      [180, 7, 7, 0],
      [240, 12, 12, 1],
    ]);
  });

  it('ignores samples outside the requested window but uses them as baseline', () => {
    // Pre-window sample sets the open for the first real bucket.
    const candles = aggregateCandles(
      [sample(10, 100), sample(120, 200)],
      INTERVAL,
      60,
      120,
    );
    expect(candles).toEqual([
      { t: 60, o: 100, h: 100, l: 100, c: 100, samples: 0 },
      { t: 120, o: 200, h: 200, l: 200, c: 200, samples: 1 },
    ]);
  });

  it('sorts unsorted input before bucketing', () => {
    const candles = aggregateCandles(
      [sample(119, 2), sample(60, 3), sample(80, 5)],
      INTERVAL,
      60,
      60,
    );
    expect(candles).toEqual([
      { t: 60, o: 3, h: 5, l: 2, c: 2, samples: 3 },
    ]);
  });

  it('aligns buckets to interval boundaries via floor()', () => {
    // A 1h window from ts=3599 to ts=3601 covers two buckets: [0, 3600).
    const candles = aggregateCandles(
      [sample(3599, 1), sample(3601, 2)],
      3600,
      3599,
      3601,
    );
    expect(candles.map((c) => c.t)).toEqual([0, 3600]);
  });
});

describe('headBlockAgeSeconds', () => {
  it('returns positive delta when head is in the past', () => {
    expect(headBlockAgeSeconds(1000, 1060)).toBe(60);
  });
  it('returns negative delta when head is in the future (clock skew)', () => {
    expect(headBlockAgeSeconds(1100, 1060)).toBe(-40);
  });
  it('caps to ±86400 to avoid absurd values from bogus timestamps', () => {
    expect(headBlockAgeSeconds(0, 10_000_000)).toBe(86_400);
    expect(headBlockAgeSeconds(10_000_000, 0)).toBe(-86_400);
  });
});

// ------------------------------------------------------------------ //
// loadSyncLogsForOhlcv
// ------------------------------------------------------------------ //
// Indexer-aware Sync-log loader used by the OHLCV route. Must:
//   - Fall back to an RPC-only scan when the indexer cursor is
//     missing.
//   - Merge indexed rows + RPC tail, dedupe on (block, reserve0,
//     reserve1), clip indexed rows to the requested block range.
import { afterEach as _afterEach, describe as _describe, expect as _expect, it as _it, vi as _vi } from 'vitest';
import type { PublicClient as _PublicClient } from 'viem';
import { loadSyncLogsForOhlcv } from '../src/lib/priceApi';

_describe('loadSyncLogsForOhlcv', () => {
  const PAIR = '0xCCcCCcCCCcCCcccCcCcCCCcCcCccCcCcCccCCCCc' as const;
  const ORIG_FETCH = globalThis.fetch;
  _afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
  });

  _it('falls back to an RPC-only scan when the indexer is unavailable', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 404 }) as Response) as typeof fetch;

    const client = {
      getLogs: _vi.fn().mockResolvedValue([
        {
          address: PAIR,
          args: { reserve0: 100n, reserve1: 200n },
          blockNumber: 500n,
        },
      ]),
    } as unknown as _PublicClient;

    const out = await loadSyncLogsForOhlcv(PAIR, 400n, 600n, client);
    _expect(out).toHaveLength(1);
    _expect(out[0]!.reserve0).toBe(100n);
    _expect(out[0]!.reserve1).toBe(200n);
  });

  _it('merges indexed rows with RPC tail and filters by block range', async () => {
    const cursor = {
      lastBlock: 500,
      chainId: 61803,
      updatedAt: '2025-11-15T12:00:00Z',
      runs: 1,
      cumulative: { transfers: 0, syncs: 2 },
    };
    // Two indexed syncs in range, one outside the requested range.
    const inRange = [
      {
        block: 450,
        ts: 1700000000,
        tx: '0xidx1',
        logIndex: 0,
        pair: PAIR.toLowerCase(),
        reserve0: '1000',
        reserve1: '2000',
      },
      {
        block: 480,
        ts: 1700000100,
        tx: '0xidx2',
        logIndex: 1,
        pair: PAIR.toLowerCase(),
        reserve0: '1100',
        reserve1: '2100',
      },
    ];
    const outOfRange = [
      {
        block: 300, // below the requested fromBlock
        ts: 1699000000,
        tx: '0xoob',
        logIndex: 0,
        pair: PAIR.toLowerCase(),
        reserve0: '1',
        reserve1: '1',
      },
    ];
    const allRows = [...inRange, ...outOfRange];
    const body = allRows.map((r) => JSON.stringify(r)).join('\n') + '\n';

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/cursor.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(cursor),
          json: async () => cursor,
        } as Response;
      }
      if (url.endsWith('.jsonl')) {
        return {
          ok: true,
          status: 200,
          text: async () => body,
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as typeof fetch;

    // RPC tail scan returns one newer sync at block 550 (past cursor 500).
    const client = {
      getLogs: _vi.fn().mockResolvedValue([
        {
          address: PAIR,
          args: { reserve0: 1200n, reserve1: 2200n },
          blockNumber: 550n,
        },
      ]),
    } as unknown as _PublicClient;

    const out = await loadSyncLogsForOhlcv(PAIR, 400n, 600n, client);
    const blocks = out.map((r) => r.blockNumber?.toString()).sort();
    _expect(blocks).toEqual(['450', '480', '550']);
    // Out-of-range row must NOT appear.
    _expect(blocks).not.toContain('300');
  });
});
