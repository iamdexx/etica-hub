import Database, { type Database as SqliteDb } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite-backed candle + latest-price store.
 *
 * Schema:
 *   candles(pair_id, bucket_start, open, high, low, close, volume_base, volume_quote, trade_count)
 *     - One row per 1-minute bucket per pool.
 *     - Longer intervals are computed server-side via SQL GROUP BY.
 *     - `pair_id` is a short string like "ETI-ETX" or "EGAZ-ETX" — not the
 *       on-chain address, so the API surface stays legible.
 *   latest_prices(pair_id, base_token, quote_token, price_base_per_quote, price_quote_per_base, ts, block_number)
 *     - Single row per pool. Updated on every Swap event.
 *   cursors(pair_id, last_block)
 *     - Indexer resumption point. One row per tracked pool.
 *
 * All prices stored as strings (REAL would lose precision for 18-decimal
 * tokens). The indexer does the decimal-aware math before write.
 */
export interface CandleRow {
  pairId: string;
  bucketStart: number; // unix seconds, 60-aligned
  open: string;
  high: string;
  low: string;
  close: string;
  volumeBase: string;
  volumeQuote: string;
  tradeCount: number;
}

export interface LatestPriceRow {
  pairId: string;
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  priceBasePerQuote: string;
  priceQuotePerBase: string;
  ts: number;
  blockNumber: number;
}

export interface PriceDb {
  upsertCandle(row: CandleRow): void;
  applySwap(
    pairId: string,
    bucketStart: number,
    price: string,
    volumeBase: string,
    volumeQuote: string,
  ): void;
  setLatestPrice(row: LatestPriceRow): void;
  getLatestPrice(pairId: string): LatestPriceRow | null;
  getCandles(pairId: string, intervalSeconds: number, limit: number): CandleRow[];
  getCursor(pairId: string): number;
  setCursor(pairId: string, block: number): void;
  close(): void;
}

export function openPriceDb(path: string): PriceDb {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db: SqliteDb = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      pair_id       TEXT    NOT NULL,
      bucket_start  INTEGER NOT NULL,
      open          TEXT    NOT NULL,
      high          TEXT    NOT NULL,
      low           TEXT    NOT NULL,
      close         TEXT    NOT NULL,
      volume_base   TEXT    NOT NULL DEFAULT '0',
      volume_quote  TEXT    NOT NULL DEFAULT '0',
      trade_count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pair_id, bucket_start)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS candles_pair_bucket_desc
      ON candles (pair_id, bucket_start DESC);

    CREATE TABLE IF NOT EXISTS latest_prices (
      pair_id                 TEXT    PRIMARY KEY,
      base_token              TEXT    NOT NULL,
      quote_token             TEXT    NOT NULL,
      price_base_per_quote    TEXT    NOT NULL,
      price_quote_per_base    TEXT    NOT NULL,
      ts                      INTEGER NOT NULL,
      block_number            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cursors (
      pair_id     TEXT PRIMARY KEY,
      last_block  INTEGER NOT NULL
    );
  `);

  const upsertCandleStmt = db.prepare(`
    INSERT INTO candles (pair_id, bucket_start, open, high, low, close, volume_base, volume_quote, trade_count)
    VALUES (@pairId, @bucketStart, @open, @high, @low, @close, @volumeBase, @volumeQuote, @tradeCount)
    ON CONFLICT(pair_id, bucket_start) DO UPDATE SET
      high         = excluded.high,
      low          = excluded.low,
      close        = excluded.close,
      volume_base  = excluded.volume_base,
      volume_quote = excluded.volume_quote,
      trade_count  = excluded.trade_count
  `);

  const getCandleStmt = db.prepare<{
    pairId: string;
    bucketStart: number;
  }>(`SELECT * FROM candles WHERE pair_id = @pairId AND bucket_start = @bucketStart`);

  const getCursorStmt = db.prepare<{ pairId: string }>(
    `SELECT last_block FROM cursors WHERE pair_id = @pairId`,
  );
  const setCursorStmt = db.prepare<{ pairId: string; block: number }>(
    `INSERT INTO cursors (pair_id, last_block) VALUES (@pairId, @block)
     ON CONFLICT(pair_id) DO UPDATE SET last_block = excluded.last_block`,
  );

  const setLatestStmt = db.prepare(`
    INSERT INTO latest_prices (pair_id, base_token, quote_token, price_base_per_quote, price_quote_per_base, ts, block_number)
    VALUES (@pairId, @baseToken, @quoteToken, @priceBasePerQuote, @priceQuotePerBase, @ts, @blockNumber)
    ON CONFLICT(pair_id) DO UPDATE SET
      base_token              = excluded.base_token,
      quote_token             = excluded.quote_token,
      price_base_per_quote    = excluded.price_base_per_quote,
      price_quote_per_base    = excluded.price_quote_per_base,
      ts                      = excluded.ts,
      block_number            = excluded.block_number
  `);

  const getLatestStmt = db.prepare<{ pairId: string }>(
    `SELECT * FROM latest_prices WHERE pair_id = @pairId`,
  );

  function applySwap(
    pairId: string,
    bucketStart: number,
    price: string,
    volumeBase: string,
    volumeQuote: string,
  ): void {
    const row = getCandleStmt.get({ pairId, bucketStart }) as
      | {
          pair_id: string;
          bucket_start: number;
          open: string;
          high: string;
          low: string;
          close: string;
          volume_base: string;
          volume_quote: string;
          trade_count: number;
        }
      | undefined;

    if (!row) {
      upsertCandleStmt.run({
        pairId,
        bucketStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeBase,
        volumeQuote,
        tradeCount: 1,
      });
      return;
    }

    const newHigh = strMax(row.high, price);
    const newLow = strMin(row.low, price);
    const newVolBase = strAdd(row.volume_base, volumeBase);
    const newVolQuote = strAdd(row.volume_quote, volumeQuote);

    upsertCandleStmt.run({
      pairId,
      bucketStart,
      open: row.open,
      high: newHigh,
      low: newLow,
      close: price,
      volumeBase: newVolBase,
      volumeQuote: newVolQuote,
      tradeCount: row.trade_count + 1,
    });
  }

  function getCandles(pairId: string, intervalSeconds: number, limit: number): CandleRow[] {
    // 1m candles aggregated into larger buckets server-side.
    // Bucket key = floor(bucket_start / intervalSeconds) * intervalSeconds.
    // open = candle at earliest 1m in bucket
    // close = candle at latest 1m in bucket
    // high/low are straightforward MAX/MIN
    // We aggregate in-application because SQLite lacks "value at min/max of another column".
    const rows = db
      .prepare<{ pairId: string }>(
        `SELECT * FROM candles WHERE pair_id = @pairId ORDER BY bucket_start ASC`,
      )
      .all({ pairId }) as Array<{
      pair_id: string;
      bucket_start: number;
      open: string;
      high: string;
      low: string;
      close: string;
      volume_base: string;
      volume_quote: string;
      trade_count: number;
    }>;

    if (rows.length === 0) return [];
    const buckets = new Map<number, CandleRow>();
    for (const r of rows) {
      const key = Math.floor(r.bucket_start / intervalSeconds) * intervalSeconds;
      const existing = buckets.get(key);
      if (!existing) {
        buckets.set(key, {
          pairId: r.pair_id,
          bucketStart: key,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volumeBase: r.volume_base,
          volumeQuote: r.volume_quote,
          tradeCount: r.trade_count,
        });
      } else {
        existing.high = strMax(existing.high, r.high);
        existing.low = strMin(existing.low, r.low);
        existing.close = r.close;
        existing.volumeBase = strAdd(existing.volumeBase, r.volume_base);
        existing.volumeQuote = strAdd(existing.volumeQuote, r.volume_quote);
        existing.tradeCount += r.trade_count;
      }
    }

    const out = Array.from(buckets.values()).sort((a, b) => b.bucketStart - a.bucketStart);
    return out.slice(0, limit).reverse();
  }

  return {
    upsertCandle(row) {
      upsertCandleStmt.run(row);
    },
    applySwap,
    setLatestPrice(row) {
      setLatestStmt.run(row);
    },
    getLatestPrice(pairId) {
      const r = getLatestStmt.get({ pairId }) as
        | {
            pair_id: string;
            base_token: `0x${string}`;
            quote_token: `0x${string}`;
            price_base_per_quote: string;
            price_quote_per_base: string;
            ts: number;
            block_number: number;
          }
        | undefined;
      if (!r) return null;
      return {
        pairId: r.pair_id,
        baseToken: r.base_token,
        quoteToken: r.quote_token,
        priceBasePerQuote: r.price_base_per_quote,
        priceQuotePerBase: r.price_quote_per_base,
        ts: r.ts,
        blockNumber: r.block_number,
      };
    },
    getCandles,
    getCursor(pairId) {
      const r = getCursorStmt.get({ pairId }) as { last_block: number } | undefined;
      return r?.last_block ?? 0;
    },
    setCursor(pairId, block) {
      setCursorStmt.run({ pairId, block });
    },
    close() {
      db.close();
    },
  };
}

// BigNumber-ish helpers for decimal strings. We only need add / max / min, and
// values are always non-negative integers in fixed 18-decimal notation, so we
// can use BigInt under the hood.
function strAdd(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}
function strMax(a: string, b: string): string {
  return BigInt(a) > BigInt(b) ? a : b;
}
function strMin(a: string, b: string): string {
  return BigInt(a) < BigInt(b) ? a : b;
}
