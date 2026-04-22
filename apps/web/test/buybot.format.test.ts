import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { formatBuy, formatAmount, formatUsd, formatPriceUnit } from '../src/lib/buybot/format';
import type { DecodedBuy } from '../src/lib/buybot/prices';

const ETX = getAddress('0xa5A1Bc6307b0b87989B8456D4b35F88a68650044') as Address;
const ETI = getAddress('0x34c61EA91bAcdA647269d4e310A86b875c09946f') as Address;

function decoded(): DecodedBuy {
  return {
    bought: {
      address: ETX,
      symbol: 'ETX',
      decimals: 18,
      totalSupply: 100_000_000n * 10n ** 18n,
    },
    spent: {
      address: ETI,
      symbol: 'ETI',
      decimals: 18,
      totalSupply: 21_000_000n * 10n ** 18n,
    },
    amountBought: 2_500n * 10n ** 18n,
    amountSpent: 100n * 10n ** 18n,
    pricePreInSpent: 0.04,
  };
}

describe('buybot format helpers', () => {
  it('formats amounts with appropriate suffixes', () => {
    expect(formatAmount(0)).toBe('0');
    expect(formatAmount(0.0001234)).toBe('0.000123');
    expect(formatAmount(1.234)).toBe('1.234');
    expect(formatAmount(1234.5)).toBe('1.23k');
    expect(formatAmount(1_234_567)).toBe('1.23M');
  });

  it('formats USD with currency prefix and suffixes', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(42.5)).toBe('$42.50');
    expect(formatUsd(1250)).toBe('$1.25k');
    expect(formatUsd(1_234_567)).toBe('$1.23M');
    expect(formatUsd(1_234_567_890)).toBe('$1.23B');
  });

  it('formats price units with more precision for small numbers', () => {
    expect(formatPriceUnit(0)).toBe('—');
    expect(formatPriceUnit(0.04)).toBe('0.04');
    expect(formatPriceUnit(0.0000012)).toMatch(/e-/);
  });
});

describe('formatBuy', () => {
  it('produces HTML with bought/spent summary, explorer link, and both market caps', () => {
    const out = formatBuy({
      decoded: decoded(),
      report: {
        amountBought: 2500,
        amountSpent: 100,
        pricePerBoughtInSpent: 0.04,
        pricePerBoughtInUsd: 0.01,
        notionalUsd: 25,
        mcBoughtUsd: 1_000_000,
        mcSpentUsd: 2_100_000,
      },
      txHash: '0xabc123',
      blockNumber: 12345n,
      explorerBaseUrl: 'https://eticahub.org',
    });

    expect(out.parseMode).toBe('HTML');
    expect(out.disableWebPreview).toBe(true);

    const { text } = out;
    expect(text).toContain('<b>ETX Buy</b>');
    expect(text).toContain('100 ETI → 2.50k ETX');
    expect(text).toContain('1 ETX = 0.04 ETI');
    expect(text).toContain('($0.0100)');
    expect(text).toContain('MC ETX');
    expect(text).toContain('$1.00M');
    expect(text).toContain('MC ETI');
    expect(text).toContain('$2.10M');
    expect(text).toContain('<a href="https://eticahub.org/explorer/tx/0xabc123">view tx</a>');
    expect(text).toContain('block 12345');
  });

  it('escapes HTML characters in symbols to prevent injection', () => {
    const buy = decoded();
    buy.bought.symbol = 'EV<IL>';
    const out = formatBuy({
      decoded: buy,
      report: {
        amountBought: 1,
        amountSpent: 1,
        pricePerBoughtInSpent: 1,
        pricePerBoughtInUsd: null,
        notionalUsd: null,
        mcBoughtUsd: null,
        mcSpentUsd: null,
      },
      txHash: '0xdead',
      blockNumber: 1n,
      explorerBaseUrl: 'https://eticahub.org',
    });
    expect(out.text).toContain('EV&lt;IL&gt;');
    expect(out.text).not.toContain('EV<IL>');
  });

  it('omits the USD price suffix when only token-denominated price is known', () => {
    const out = formatBuy({
      decoded: decoded(),
      report: {
        amountBought: 1,
        amountSpent: 1,
        pricePerBoughtInSpent: 2,
        pricePerBoughtInUsd: null,
        notionalUsd: null,
        mcBoughtUsd: null,
        mcSpentUsd: null,
      },
      txHash: '0xdead',
      blockNumber: 2n,
      explorerBaseUrl: 'https://eticahub.org',
    });
    expect(out.text).toContain('1 ETX = 2 ETI');
    expect(out.text).not.toContain('(—)');
  });
});
