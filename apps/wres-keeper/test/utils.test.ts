import { describe, expect, it, vi } from 'vitest';
import { formatTrx, sunToEtrxWei, withRetry } from '../src/utils.js';

describe('formatTrx', () => {
  it('formats whole TRX', () => {
    expect(formatTrx(1_000_000n)).toBe('1 TRX');
  });
  it('trims trailing zeros in the fraction', () => {
    expect(formatTrx(1_500_000n)).toBe('1.5 TRX');
    expect(formatTrx(1_230_000n)).toBe('1.23 TRX');
  });
  it('handles sub-TRX and zero', () => {
    expect(formatTrx(1n)).toBe('0.000001 TRX');
    expect(formatTrx(0n)).toBe('0 TRX');
  });
  it('handles negatives', () => {
    expect(formatTrx(-1_500_000n)).toBe('-1.5 TRX');
  });
});

describe('sunToEtrxWei', () => {
  it('scales 6dp SUN to 18dp wei (1:1 TRX<->eTRX)', () => {
    expect(sunToEtrxWei(1_000_000n)).toBe(10n ** 18n); // 1 TRX -> 1 eTRX
    expect(sunToEtrxWei(0n)).toBe(0n);
  });
});

describe('withRetry', () => {
  it('returns on first success without delay', async () => {
    const fn = vi.fn(async () => 42);
    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 0 })).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw new Error('blip');
      return 'ok';
    });
    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 0 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always');
    });
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 0 })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
