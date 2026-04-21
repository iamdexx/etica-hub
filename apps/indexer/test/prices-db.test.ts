import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openPriceDb, type PriceDb } from '../src/prices/db';

describe('PriceDb', () => {
  let db: PriceDb;

  beforeEach(() => {
    db = openPriceDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('cursor', () => {
    it('returns 0 for unknown pair', () => {
      expect(db.getCursor('ETI-ETX')).toBe(0);
    });

    it('sets and reads cursor', () => {
      db.setCursor('ETI-ETX', 1234);
      expect(db.getCursor('ETI-ETX')).toBe(1234);
    });

    it('upserts cursor on subsequent writes', () => {
      db.setCursor('ETI-ETX', 1234);
      db.setCursor('ETI-ETX', 5678);
      expect(db.getCursor('ETI-ETX')).toBe(5678);
    });

    it('isolates cursors per pair', () => {
      db.setCursor('ETI-ETX', 1);
      db.setCursor('EGAZ-ETX', 2);
      expect(db.getCursor('ETI-ETX')).toBe(1);
      expect(db.getCursor('EGAZ-ETX')).toBe(2);
    });
  });

  describe('latest price', () => {
    it('returns null for unknown pair', () => {
      expect(db.getLatestPrice('ETI-ETX')).toBeNull();
    });

    it('upserts latest price', () => {
      db.setLatestPrice({
        pairId: 'ETI-ETX',
        baseToken: '0x1111111111111111111111111111111111111111',
        quoteToken: '0x2222222222222222222222222222222222222222',
        priceBasePerQuote: '100',
        priceQuotePerBase: '500',
        ts: 1_700_000_000,
        blockNumber: 100,
      });
      const row = db.getLatestPrice('ETI-ETX');
      expect(row).not.toBeNull();
      expect(row?.priceQuotePerBase).toBe('500');
      expect(row?.blockNumber).toBe(100);
    });

    it('overwrites on subsequent writes', () => {
      db.setLatestPrice({
        pairId: 'ETI-ETX',
        baseToken: '0x1111111111111111111111111111111111111111',
        quoteToken: '0x2222222222222222222222222222222222222222',
        priceBasePerQuote: '100',
        priceQuotePerBase: '500',
        ts: 1_700_000_000,
        blockNumber: 100,
      });
      db.setLatestPrice({
        pairId: 'ETI-ETX',
        baseToken: '0x1111111111111111111111111111111111111111',
        quoteToken: '0x2222222222222222222222222222222222222222',
        priceBasePerQuote: '110',
        priceQuotePerBase: '550',
        ts: 1_700_000_100,
        blockNumber: 110,
      });
      expect(db.getLatestPrice('ETI-ETX')?.blockNumber).toBe(110);
      expect(db.getLatestPrice('ETI-ETX')?.priceQuotePerBase).toBe('550');
    });
  });

  describe('applySwap / candles', () => {
    it('creates a new candle on first swap in a bucket', () => {
      // 1_700_000_040 is minute-aligned.
      db.applySwap('ETI-ETX', 1_700_000_040, '1000', '10', '1000');
      const candles = db.getCandles('ETI-ETX', 60, 100);
      expect(candles).toHaveLength(1);
      expect(candles[0]).toMatchObject({
        bucketStart: 1_700_000_040,
        open: '1000',
        high: '1000',
        low: '1000',
        close: '1000',
        volumeBase: '10',
        volumeQuote: '1000',
        tradeCount: 1,
      });
    });

    it('updates existing candle on subsequent swaps in same bucket', () => {
      // 1_700_000_040 is minute-aligned.
      db.applySwap('ETI-ETX', 1_700_000_040, '1000', '10', '1000');
      db.applySwap('ETI-ETX', 1_700_000_040, '1200', '5', '600'); // new high
      db.applySwap('ETI-ETX', 1_700_000_040, '900', '7', '630'); // new low
      db.applySwap('ETI-ETX', 1_700_000_040, '1100', '3', '330'); // close

      const candles = db.getCandles('ETI-ETX', 60, 100);
      expect(candles).toHaveLength(1);
      expect(candles[0].open).toBe('1000');
      expect(candles[0].high).toBe('1200');
      expect(candles[0].low).toBe('900');
      expect(candles[0].close).toBe('1100');
      expect(candles[0].tradeCount).toBe(4);
      // volumeBase = 10 + 5 + 7 + 3 = 25
      expect(candles[0].volumeBase).toBe('25');
      // volumeQuote = 1000 + 600 + 630 + 330 = 2560
      expect(candles[0].volumeQuote).toBe('2560');
    });

    it('aggregates multiple 1m buckets into a larger interval', () => {
      // 1_699_999_800 is divisible by 300 (5m bucket boundary), so the next three
      // 1m buckets (1_699_999_800, 1_699_999_860, 1_699_999_920) all fall in the
      // same 5m bucket starting at 1_699_999_800.
      db.applySwap('ETI-ETX', 1_699_999_800, '1000', '10', '10000');
      db.applySwap('ETI-ETX', 1_699_999_860, '1200', '5', '6000');
      db.applySwap('ETI-ETX', 1_699_999_920, '900', '8', '7200');

      const candles = db.getCandles('ETI-ETX', 300, 100);
      expect(candles).toHaveLength(1);
      expect(candles[0].bucketStart).toBe(1_699_999_800);
      expect(candles[0].open).toBe('1000');
      expect(candles[0].close).toBe('900');
      expect(candles[0].high).toBe('1200');
      expect(candles[0].low).toBe('900');
      expect(candles[0].tradeCount).toBe(3);
      expect(candles[0].volumeBase).toBe('23'); // 10+5+8
    });

    it('limits results and returns in ascending order', () => {
      // 1_700_000_040 is divisible by 60 (minute-aligned).
      const base = 1_700_000_040;
      for (let i = 0; i < 10; i++) {
        db.applySwap('ETI-ETX', base + i * 60, `${1000 + i}`, '1', '1');
      }
      const candles = db.getCandles('ETI-ETX', 60, 3);
      expect(candles).toHaveLength(3);
      expect(candles[0].bucketStart).toBe(base + 7 * 60);
      expect(candles[1].bucketStart).toBe(base + 8 * 60);
      expect(candles[2].bucketStart).toBe(base + 9 * 60);
    });

    it('returns empty array for pair with no candles', () => {
      expect(db.getCandles('UNKNOWN', 60, 100)).toEqual([]);
    });

    it('isolates candles per pair', () => {
      // 1_700_000_040 is minute-aligned.
      db.applySwap('ETI-ETX', 1_700_000_040, '1000', '1', '1000');
      db.applySwap('EGAZ-ETX', 1_700_000_040, '50', '1', '50');
      const eti = db.getCandles('ETI-ETX', 60, 100);
      const egaz = db.getCandles('EGAZ-ETX', 60, 100);
      expect(eti).toHaveLength(1);
      expect(egaz).toHaveLength(1);
      expect(eti[0].open).toBe('1000');
      expect(egaz[0].open).toBe('50');
    });
  });
});
