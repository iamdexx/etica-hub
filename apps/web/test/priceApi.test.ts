import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import {
  apiTokens,
  priceVia,
  spotPriceFromReserves,
  tokenByAddress,
  tokenById,
  type ApiPairRaw,
  type ApiToken,
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
