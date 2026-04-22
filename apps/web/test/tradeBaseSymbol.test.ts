import { describe, expect, it } from 'vitest';
import {
  availableTradeBaseSymbols,
  parseTradeBaseSymbol,
  resolveBaseTokenAddress,
  TRADE_BASE_PAIR_IDS,
} from '@/lib/trading/baseSymbol';

const ZERO = '0x0000000000000000000000000000000000000000';
const ETICA_MAINNET = 61803;
const UNSUPPORTED_CHAIN = 1;

describe('parseTradeBaseSymbol', () => {
  it('accepts all three canonical symbols, case-insensitively', () => {
    expect(parseTradeBaseSymbol('ETI')).toBe('ETI');
    expect(parseTradeBaseSymbol('eti')).toBe('ETI');
    expect(parseTradeBaseSymbol('EGAZ')).toBe('EGAZ');
    expect(parseTradeBaseSymbol('egaz')).toBe('EGAZ');
    expect(parseTradeBaseSymbol('stETX')).toBe('stETX');
    expect(parseTradeBaseSymbol('stetx')).toBe('stETX');
    expect(parseTradeBaseSymbol('STETX')).toBe('stETX');
  });

  it('returns null for unknown slugs so the route can 404', () => {
    expect(parseTradeBaseSymbol('ETX')).toBeNull();
    expect(parseTradeBaseSymbol('weth')).toBeNull();
    expect(parseTradeBaseSymbol('')).toBeNull();
  });
});

describe('TRADE_BASE_PAIR_IDS', () => {
  it('maps each base to a <base>-ETX pair id', () => {
    expect(TRADE_BASE_PAIR_IDS.ETI).toBe('ETI-ETX');
    expect(TRADE_BASE_PAIR_IDS.EGAZ).toBe('EGAZ-ETX');
    expect(TRADE_BASE_PAIR_IDS.stETX).toBe('stETX-ETX');
  });
});

describe('resolveBaseTokenAddress', () => {
  it('returns the deployed address on Etica mainnet', () => {
    expect(resolveBaseTokenAddress(ETICA_MAINNET, 'ETI')).not.toBe(ZERO);
    expect(resolveBaseTokenAddress(ETICA_MAINNET, 'EGAZ')).not.toBe(ZERO);
    expect(resolveBaseTokenAddress(ETICA_MAINNET, 'stETX')).not.toBe(ZERO);
  });

  it('returns the zero address on unsupported chains', () => {
    expect(resolveBaseTokenAddress(UNSUPPORTED_CHAIN, 'ETI')).toBe(ZERO);
    expect(resolveBaseTokenAddress(UNSUPPORTED_CHAIN, 'stETX')).toBe(ZERO);
  });
});

describe('availableTradeBaseSymbols', () => {
  it('surfaces all three bases on Etica mainnet', () => {
    expect(availableTradeBaseSymbols(ETICA_MAINNET)).toEqual(['ETI', 'EGAZ', 'stETX']);
  });

  it('is empty on unsupported chains', () => {
    expect(availableTradeBaseSymbols(UNSUPPORTED_CHAIN)).toEqual([]);
  });
});
