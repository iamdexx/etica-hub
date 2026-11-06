import { describe, expect, it } from 'vitest';
import { makeWidgetPool, resolveWidgetPool, type WidgetToken } from '../src/lib/widget/poolKeys';

const t = (symbol: string, native = false): WidgetToken => ({
  address: `0x${symbol.replace('.', '').padEnd(40, '0')}` as `0x${string}`,
  symbol,
  decimals: symbol === 'USDC.e' ? 6 : 18,
  native,
});
const egazUsdc = makeWidgetPool('0x0000000000000000000000000000000000000001', t('USDC.e'), t('EGAZ', true));
const etiUsdc = makeWidgetPool('0x0000000000000000000000000000000000000002', t('ETI'), t('USDC.e'));
const etiEtx = makeWidgetPool('0x0000000000000000000000000000000000000003', t('ETX'), t('ETI'));
const usdcEtx = makeWidgetPool('0x0000000000000000000000000000000000000004', t('USDC.e'), t('ETX'));
const stEtx = makeWidgetPool('0x0000000000000000000000000000000000000005', t('stETX'), t('ETX'));
const pools = [egazUsdc, etiUsdc, etiEtx, usdcEtx, stEtx];

describe('widget pool keys', () => {
  it('puts USDC.e, then ETX, on the quote side whatever the on-chain token order', () => {
    expect(egazUsdc.label).toBe('EGAZ/USDC.e');
    expect(etiUsdc.label).toBe('ETI/USDC.e');
    expect(etiEtx.label).toBe('ETI/ETX');
    expect(usdcEtx.label).toBe('ETX/USDC.e');
    expect(stEtx.label).toBe('stETX/ETX');
    expect(etiEtx.key).toBe('eti-etx');
  });
  it('keeps the legacy ?pair=egaz|eti links working', () => {
    expect(resolveWidgetPool(pools, 'egaz')).toBe(egazUsdc);
    expect(resolveWidgetPool(pools, 'ETI')).toBe(etiUsdc);
  });
  it('resolves base-quote keys in either order and pool addresses', () => {
    expect(resolveWidgetPool(pools, 'eti-etx')).toBe(etiEtx);
    expect(resolveWidgetPool(pools, 'etx-eti')).toBe(etiEtx);
    expect(resolveWidgetPool(pools, 'stetx-etx')).toBe(stEtx);
    expect(resolveWidgetPool(pools, '0x0000000000000000000000000000000000000004')).toBe(usdcEtx);
  });
  it('falls back to the first pool when the param is empty and to null when unknown', () => {
    expect(resolveWidgetPool(pools, undefined)).toBe(egazUsdc);
    expect(resolveWidgetPool(pools, 'nope')).toBeNull();
    expect(resolveWidgetPool([], 'egaz')).toBeNull();
  });
});
