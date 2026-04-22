import { describe, it, expect } from 'vitest';
import { decodeAbiParameters, parseAbiParameters, parseUnits, type Hex } from 'viem';
import {
  baseFromQuote,
  buildDcaLegs,
  buildGridLegs,
  buildInfiniteGridLegs,
  buildLimitOrder,
  buildPermit2WitnessTypedData,
  encodeDutchOrder,
  orderBookHash,
  quoteFromBase,
  randomDcaBatchId,
  randomGridBatchId,
  randomPermit2Nonce,
} from '../src/lib/trading/dutchOrder';

const REACTOR = '0x0101010101010101010101010101010101010101' as const;
const SWAPPER = '0x0202020202020202020202020202020202020202' as const;
const BASE = '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as const;
const QUOTE = '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044' as const;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

const NOW = Math.floor(Date.now() / 1000);
const DEADLINE = NOW + 3600;

describe('quoteFromBase / baseFromQuote', () => {
  it('scales by 1e18 fixed-point price', () => {
    const price = parseUnits('1.5', 18); // 1.5 quote per base
    expect(quoteFromBase(parseUnits('2', 18), price)).toBe(parseUnits('3', 18));
    expect(baseFromQuote(parseUnits('3', 18), price)).toBe(parseUnits('2', 18));
  });
  it('rounds toward zero on division', () => {
    // price = 0.5 + 1 wei; selling 1 base wei → 0 quote wei (floored).
    const price = parseUnits('0.5', 18) + 1n;
    const q = quoteFromBase(1n, price);
    expect(q).toBe(0n);
  });
  it('rejects zero price on baseFromQuote', () => {
    expect(() => baseFromQuote(1n, 0n)).toThrow(/zero/);
  });
});

describe('randomPermit2Nonce', () => {
  it('returns a uint256-bounded bigint', () => {
    const n = randomPermit2Nonce();
    expect(typeof n).toBe('bigint');
    expect(n >= 0n).toBe(true);
    expect(n < 1n << 256n).toBe(true);
  });
  it('does not repeat within a small sample', () => {
    const s = new Set<string>();
    for (let i = 0; i < 64; i++) s.add(randomPermit2Nonce().toString());
    expect(s.size).toBe(64);
  });
});

describe('buildLimitOrder', () => {
  it('builds a flat (no-decay) sell order with base → quote direction', () => {
    const baseAmount = parseUnits('100', 18);
    const price = parseUnits('1.5', 18);
    const order = buildLimitOrder({
      reactor: REACTOR,
      swapper: SWAPPER,
      side: 'sell',
      baseToken: BASE,
      quoteToken: QUOTE,
      baseAmount,
      pricePerBase18: price,
      baseDecimals: 18,
      quoteDecimals: 18,
      deadlineSec: DEADLINE,
      nonce: 42n,
    });
    expect(order.info.reactor).toBe(REACTOR);
    expect(order.info.swapper).toBe(SWAPPER);
    expect(order.info.nonce).toBe(42n);
    expect(order.info.deadline).toBe(BigInt(DEADLINE));
    expect(order.input.token).toBe(BASE);
    expect(order.input.startAmount).toBe(baseAmount);
    expect(order.input.endAmount).toBe(baseAmount);
    expect(order.outputs).toHaveLength(1);
    expect(order.outputs[0].token).toBe(QUOTE);
    expect(order.outputs[0].startAmount).toBe(parseUnits('150', 18));
    expect(order.outputs[0].endAmount).toBe(parseUnits('150', 18));
    expect(order.outputs[0].recipient).toBe(SWAPPER);
    // Flat limit: decayStart == decayEnd
    expect(order.decayStartTime).toBe(order.decayEndTime);
    // Decay window must fit inside the deadline
    expect(order.decayEndTime <= BigInt(DEADLINE)).toBe(true);
  });

  it('flips direction for buy side: input becomes quote', () => {
    const order = buildLimitOrder({
      reactor: REACTOR,
      swapper: SWAPPER,
      side: 'buy',
      baseToken: BASE,
      quoteToken: QUOTE,
      baseAmount: parseUnits('10', 18),
      pricePerBase18: parseUnits('2', 18),
      baseDecimals: 18,
      quoteDecimals: 18,
      deadlineSec: DEADLINE,
      nonce: 1n,
    });
    expect(order.input.token).toBe(QUOTE);
    expect(order.input.startAmount).toBe(parseUnits('20', 18));
    expect(order.outputs[0].token).toBe(BASE);
    expect(order.outputs[0].startAmount).toBe(parseUnits('10', 18));
  });

  it('rejects zero base amount', () => {
    expect(() =>
      buildLimitOrder({
        reactor: REACTOR,
        swapper: SWAPPER,
        side: 'sell',
        baseToken: BASE,
        quoteToken: QUOTE,
        baseAmount: 0n,
        pricePerBase18: parseUnits('1', 18),
        baseDecimals: 18,
        quoteDecimals: 18,
        deadlineSec: DEADLINE,
        nonce: 1n,
      }),
    ).toThrow(/baseAmount/);
  });

  it('rejects zero price', () => {
    expect(() =>
      buildLimitOrder({
        reactor: REACTOR,
        swapper: SWAPPER,
        side: 'sell',
        baseToken: BASE,
        quoteToken: QUOTE,
        baseAmount: 1n,
        pricePerBase18: 0n,
        baseDecimals: 18,
        quoteDecimals: 18,
        deadlineSec: DEADLINE,
        nonce: 1n,
      }),
    ).toThrow(/pricePerBase18/);
  });

  it('rejects past deadlines', () => {
    expect(() =>
      buildLimitOrder({
        reactor: REACTOR,
        swapper: SWAPPER,
        side: 'sell',
        baseToken: BASE,
        quoteToken: QUOTE,
        baseAmount: 1n,
        pricePerBase18: parseUnits('1', 18),
        baseDecimals: 18,
        quoteDecimals: 18,
        deadlineSec: NOW - 1,
        nonce: 1n,
      }),
    ).toThrow(/future/);
  });
});

describe('encodeDutchOrder round-trip', () => {
  it('ABI-encodes and decodes back to the same struct', () => {
    const order = buildLimitOrder({
      reactor: REACTOR,
      swapper: SWAPPER,
      side: 'sell',
      baseToken: BASE,
      quoteToken: QUOTE,
      baseAmount: parseUnits('5', 18),
      pricePerBase18: parseUnits('0.5', 18),
      baseDecimals: 18,
      quoteDecimals: 18,
      deadlineSec: DEADLINE,
      nonce: 12345n,
    });
    const encoded: Hex = encodeDutchOrder(order);
    expect(encoded.startsWith('0x')).toBe(true);

    const params = parseAbiParameters([
      'DutchOrder order',
      'struct DutchOrder { OrderInfo info; uint256 decayStartTime; uint256 decayEndTime; DutchInput input; DutchOutput[] outputs; }',
      'struct OrderInfo { address reactor; address swapper; uint256 nonce; uint256 deadline; address additionalValidationContract; bytes additionalValidationData; }',
      'struct DutchInput { address token; uint256 startAmount; uint256 endAmount; }',
      'struct DutchOutput { address token; uint256 startAmount; uint256 endAmount; address recipient; }',
    ]);
    const [decoded] = decodeAbiParameters(params, encoded);
    expect(decoded.info.reactor.toLowerCase()).toBe(REACTOR.toLowerCase());
    expect(decoded.info.swapper.toLowerCase()).toBe(SWAPPER.toLowerCase());
    expect(decoded.info.nonce).toBe(12345n);
    expect(decoded.info.deadline).toBe(BigInt(DEADLINE));
    expect(decoded.input.startAmount).toBe(order.input.startAmount);
    expect(decoded.outputs[0].recipient.toLowerCase()).toBe(SWAPPER.toLowerCase());
  });

  it('orderBookHash is deterministic and 32 bytes', () => {
    const order = buildLimitOrder({
      reactor: REACTOR,
      swapper: SWAPPER,
      side: 'sell',
      baseToken: BASE,
      quoteToken: QUOTE,
      baseAmount: 1n,
      pricePerBase18: 1n,
      baseDecimals: 18,
      quoteDecimals: 18,
      deadlineSec: DEADLINE,
      nonce: 7n,
    });
    const encoded = encodeDutchOrder(order);
    const h1 = orderBookHash(encoded);
    const h2 = orderBookHash(encoded);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('randomDcaBatchId', () => {
  it('returns a nonempty string', () => {
    const id = randomDcaBatchId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(8);
  });
  it('is unique across a small sample', () => {
    const s = new Set<string>();
    for (let i = 0; i < 32; i++) s.add(randomDcaBatchId());
    expect(s.size).toBe(32);
  });
});

describe('buildDcaLegs', () => {
  const baseParams = {
    reactor: REACTOR,
    swapper: SWAPPER,
    side: 'buy' as const,
    baseToken: BASE,
    quoteToken: QUOTE,
    pricePerBase18: parseUnits('1.5', 18),
    baseDecimals: 18,
    quoteDecimals: 18,
    intervalSec: 60 * 60,
    firstLegStartSec: NOW,
    legValiditySec: 24 * 60 * 60,
  };

  it('produces N legs with staggered decayStartTime and unique nonces', () => {
    let nonce = 100n;
    const legs = buildDcaLegs({
      ...baseParams,
      totalBaseAmount: parseUnits('10', 18),
      legs: 5,
      nonceGenerator: () => nonce++,
    });
    expect(legs).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(legs[i].index).toBe(i);
      expect(legs[i].decayStartSec).toBe(NOW + i * 60 * 60);
      expect(legs[i].order.info.nonce).toBe(BigInt(100 + i));
      // Flat decay per leg — each leg is effectively a limit order at its start time.
      expect(legs[i].order.decayStartTime).toBe(legs[i].order.decayEndTime);
    }
  });

  it('splits totalBaseAmount evenly with remainder on the last leg', () => {
    // 10 / 3 = 3 r 1 — first two legs get 3, last leg gets 4.
    const legs = buildDcaLegs({
      ...baseParams,
      totalBaseAmount: 10n,
      legs: 3,
      nonceGenerator: () => 1n,
    });
    // side=buy → input is quote, output is base; base amount is the output.
    expect(legs[0].order.outputs[0].startAmount).toBe(3n);
    expect(legs[1].order.outputs[0].startAmount).toBe(3n);
    expect(legs[2].order.outputs[0].startAmount).toBe(4n);
    const sum =
      legs[0].order.outputs[0].startAmount +
      legs[1].order.outputs[0].startAmount +
      legs[2].order.outputs[0].startAmount;
    expect(sum).toBe(10n);
  });

  it('rejects legs < 2', () => {
    expect(() =>
      buildDcaLegs({ ...baseParams, totalBaseAmount: 100n, legs: 1 }),
    ).toThrow(/at least 2/);
  });

  it('rejects legs > 50', () => {
    expect(() =>
      buildDcaLegs({ ...baseParams, totalBaseAmount: 100n, legs: 51 }),
    ).toThrow(/50/);
  });

  it('rejects intervalSec < 60', () => {
    expect(() =>
      buildDcaLegs({
        ...baseParams,
        intervalSec: 30,
        totalBaseAmount: 100n,
        legs: 3,
      }),
    ).toThrow(/intervalSec/);
  });

  it('rejects totalBaseAmount < legs', () => {
    expect(() =>
      buildDcaLegs({ ...baseParams, totalBaseAmount: 2n, legs: 3 }),
    ).toThrow(/legs/);
  });
});

describe('buildGridLegs', () => {
  const baseParams = {
    reactor: REACTOR,
    swapper: SWAPPER,
    baseToken: BASE,
    quoteToken: QUOTE,
    baseDecimals: 18,
    quoteDecimals: 18,
    startSec: NOW,
    deadlineSec: NOW + 7 * 24 * 60 * 60,
    baseAmountPerLevel: parseUnits('1', 18),
  };

  it('produces N levels at evenly-spaced prices split around the reference', () => {
    let nonce = 1n;
    const legs = buildGridLegs({
      ...baseParams,
      lowPrice18: parseUnits('1', 18),
      highPrice18: parseUnits('2', 18),
      referencePrice18: parseUnits('1.5', 18),
      levels: 5,
      nonceGenerator: () => nonce++,
    });
    // step = (2 - 1) / 4 = 0.25 → candidates 1, 1.25, 1.5, 1.75, 2.
    // 1.5 is exactly the reference — dropped to avoid an immediate fill.
    expect(legs).toHaveLength(4);
    const prices = legs.map((l) => l.pricePerBase18);
    expect(prices).toContain(parseUnits('1', 18));
    expect(prices).toContain(parseUnits('1.25', 18));
    expect(prices).toContain(parseUnits('1.75', 18));
    expect(prices).toContain(parseUnits('2', 18));
    expect(prices).not.toContain(parseUnits('1.5', 18));
  });

  it('emits contiguous 0-based indices even when a candidate level is skipped', () => {
    const legs = buildGridLegs({
      ...baseParams,
      lowPrice18: parseUnits('1', 18),
      highPrice18: parseUnits('2', 18),
      referencePrice18: parseUnits('1.5', 18),
      levels: 5,
      nonceGenerator: () => 1n,
    });
    // The 3rd candidate (1.5) coincides with the reference and is dropped, so
    // indices must be [0, 1, 2, 3] rather than [0, 1, 3, 4] — otherwise the
    // orderbook's `gridIndex < gridTotal` guard would reject the top level.
    expect(legs.map((l) => l.index)).toEqual([0, 1, 2, 3]);
    for (let i = 0; i < legs.length; i++) expect(legs[i].index).toBeLessThan(legs.length);
  });

  it('anchors the top level exactly at highPrice18 despite integer-division drift', () => {
    const legs = buildGridLegs({
      ...baseParams,
      lowPrice18: 1n,
      highPrice18: 10n,
      referencePrice18: 5n,
      levels: 4,
      nonceGenerator: () => 1n,
    });
    // Top level must equal highPrice18 exactly regardless of (10-1)/3 drift.
    expect(legs[legs.length - 1].pricePerBase18).toBe(10n);
  });

  it('splits levels into buys below and sells above reference', () => {
    const legs = buildGridLegs({
      ...baseParams,
      lowPrice18: parseUnits('1', 18),
      highPrice18: parseUnits('3', 18),
      referencePrice18: parseUnits('2', 18),
      levels: 5,
      nonceGenerator: () => 1n,
    });
    const buys = legs.filter((l) => l.side === 'buy');
    const sells = legs.filter((l) => l.side === 'sell');
    // prices: 1, 1.5, 2 (ref → skipped), 2.5, 3 → 2 buys, 2 sells.
    expect(buys).toHaveLength(2);
    expect(sells).toHaveLength(2);
    for (const b of buys) expect(b.pricePerBase18 < parseUnits('2', 18)).toBe(true);
    for (const s of sells) expect(s.pricePerBase18 > parseUnits('2', 18)).toBe(true);
  });

  it('gives every level the same decayStart and deadline (simultaneously eligible)', () => {
    const legs = buildGridLegs({
      ...baseParams,
      lowPrice18: parseUnits('1', 18),
      highPrice18: parseUnits('2', 18),
      referencePrice18: parseUnits('1.4', 18),
      levels: 4,
      nonceGenerator: () => 1n,
    });
    for (const l of legs) {
      expect(l.decayStartSec).toBe(baseParams.startSec);
      expect(l.deadlineSec).toBe(baseParams.deadlineSec);
      expect(l.order.decayStartTime).toBe(l.order.decayEndTime);
    }
  });

  it('uses unique nonces from the injected generator', () => {
    let nonce = 1000n;
    const legs = buildGridLegs({
      ...baseParams,
      lowPrice18: parseUnits('1', 18),
      highPrice18: parseUnits('2', 18),
      referencePrice18: parseUnits('1.3', 18),
      levels: 4,
      nonceGenerator: () => nonce++,
    });
    const nonces = new Set(legs.map((l) => l.order.info.nonce.toString()));
    expect(nonces.size).toBe(legs.length);
  });

  it('rejects levels < 2', () => {
    expect(() =>
      buildGridLegs({
        ...baseParams,
        lowPrice18: parseUnits('1', 18),
        highPrice18: parseUnits('2', 18),
        referencePrice18: parseUnits('1.5', 18),
        levels: 1,
      }),
    ).toThrow(/at least 2/);
  });

  it('rejects levels > 50', () => {
    expect(() =>
      buildGridLegs({
        ...baseParams,
        lowPrice18: parseUnits('1', 18),
        highPrice18: parseUnits('2', 18),
        referencePrice18: parseUnits('1.5', 18),
        levels: 51,
      }),
    ).toThrow(/50/);
  });

  it('rejects highPrice18 <= lowPrice18', () => {
    expect(() =>
      buildGridLegs({
        ...baseParams,
        lowPrice18: parseUnits('2', 18),
        highPrice18: parseUnits('2', 18),
        referencePrice18: parseUnits('2', 18),
        levels: 4,
      }),
    ).toThrow(/highPrice18/);
  });

  it('rejects reference price at or outside the bounds', () => {
    expect(() =>
      buildGridLegs({
        ...baseParams,
        lowPrice18: parseUnits('1', 18),
        highPrice18: parseUnits('2', 18),
        referencePrice18: parseUnits('1', 18),
        levels: 4,
      }),
    ).toThrow(/referencePrice18/);
    expect(() =>
      buildGridLegs({
        ...baseParams,
        lowPrice18: parseUnits('1', 18),
        highPrice18: parseUnits('2', 18),
        referencePrice18: parseUnits('3', 18),
        levels: 4,
      }),
    ).toThrow(/referencePrice18/);
  });

  it('rejects baseAmountPerLevel <= 0', () => {
    expect(() =>
      buildGridLegs({
        ...baseParams,
        lowPrice18: parseUnits('1', 18),
        highPrice18: parseUnits('2', 18),
        referencePrice18: parseUnits('1.5', 18),
        levels: 4,
        baseAmountPerLevel: 0n,
      }),
    ).toThrow(/baseAmountPerLevel/);
  });

  it('rejects deadline too close to start', () => {
    expect(() =>
      buildGridLegs({
        ...baseParams,
        lowPrice18: parseUnits('1', 18),
        highPrice18: parseUnits('2', 18),
        referencePrice18: parseUnits('1.5', 18),
        levels: 4,
        deadlineSec: NOW + 100,
      }),
    ).toThrow(/deadlineSec/);
  });
});

describe('randomGridBatchId', () => {
  it('returns non-empty string', () => {
    expect(randomGridBatchId().length).toBeGreaterThan(8);
  });
  it('is unique across a small sample', () => {
    const s = new Set<string>();
    for (let i = 0; i < 32; i++) s.add(randomGridBatchId());
    expect(s.size).toBe(32);
  });
});

describe('buildInfiniteGridLegs', () => {
  const baseParams = {
    reactor: REACTOR,
    swapper: SWAPPER,
    baseToken: BASE,
    quoteToken: QUOTE,
    baseDecimals: 18,
    quoteDecimals: 18,
    referencePrice18: parseUnits('100', 18),
    stepPctE18: parseUnits('0.02', 18), // 2% per level
    buyLevels: 3,
    sellLevels: 3,
    baseAmountPerLevel: parseUnits('1', 18),
    startSec: NOW,
    deadlineSec: DEADLINE,
  } as const;

  it('produces buys + sells in ascending price order around the reference', () => {
    let nonce = 1n;
    const legs = buildInfiniteGridLegs({
      ...baseParams,
      nonceGenerator: () => nonce++,
    });
    expect(legs.length).toBe(6);
    // Ascending price across the whole array.
    for (let i = 1; i < legs.length; i += 1) {
      expect(legs[i].pricePerBase18).toBeGreaterThan(legs[i - 1].pricePerBase18);
    }
    // First three are buys (below ref), last three are sells (above ref).
    for (let i = 0; i < 3; i += 1) {
      expect(legs[i].side).toBe('buy');
      expect(legs[i].pricePerBase18).toBeLessThan(baseParams.referencePrice18);
    }
    for (let i = 3; i < 6; i += 1) {
      expect(legs[i].side).toBe('sell');
      expect(legs[i].pricePerBase18).toBeGreaterThan(baseParams.referencePrice18);
    }
  });

  it('places the nearest buy at R*(1-p) and nearest sell at R*(1+p)', () => {
    const legs = buildInfiniteGridLegs({ ...baseParams, buyLevels: 1, sellLevels: 1 });
    expect(legs.length).toBe(2);
    const ONE = 10n ** 18n;
    const down = ONE - baseParams.stepPctE18;
    const up = ONE + baseParams.stepPctE18;
    expect(legs[0].pricePerBase18).toBe((baseParams.referencePrice18 * down) / ONE);
    expect(legs[1].pricePerBase18).toBe((baseParams.referencePrice18 * up) / ONE);
  });

  it('produces contiguous 0-based indices', () => {
    const legs = buildInfiniteGridLegs({ ...baseParams, buyLevels: 4, sellLevels: 2 });
    expect(legs.length).toBe(6);
    for (let i = 0; i < legs.length; i += 1) {
      expect(legs[i].index).toBe(i);
    }
  });

  it('supports asymmetric grids (buys-only or sells-only)', () => {
    const buysOnly = buildInfiniteGridLegs({ ...baseParams, buyLevels: 5, sellLevels: 0 });
    expect(buysOnly.length).toBe(5);
    expect(buysOnly.every((l) => l.side === 'buy')).toBe(true);
    const sellsOnly = buildInfiniteGridLegs({ ...baseParams, buyLevels: 0, sellLevels: 5 });
    expect(sellsOnly.length).toBe(5);
    expect(sellsOnly.every((l) => l.side === 'sell')).toBe(true);
  });

  it('shares decayStart + deadline across all levels', () => {
    const legs = buildInfiniteGridLegs(baseParams);
    for (const lvl of legs) {
      expect(lvl.decayStartSec).toBe(baseParams.startSec);
      expect(lvl.deadlineSec).toBe(baseParams.deadlineSec);
      expect(lvl.order.decayStartTime).toBe(BigInt(baseParams.startSec));
      expect(lvl.order.decayEndTime).toBe(BigInt(baseParams.startSec));
    }
  });

  it('injected nonce generator provides unique nonces', () => {
    let nonce = 1000n;
    const legs = buildInfiniteGridLegs({
      ...baseParams,
      nonceGenerator: () => nonce++,
    });
    const nonces = new Set(legs.map((l) => l.order.info.nonce.toString()));
    expect(nonces.size).toBe(legs.length);
  });

  it('rejects zero reference price', () => {
    expect(() =>
      buildInfiniteGridLegs({ ...baseParams, referencePrice18: 0n }),
    ).toThrow(/referencePrice18/);
  });

  it('rejects zero step', () => {
    expect(() => buildInfiniteGridLegs({ ...baseParams, stepPctE18: 0n })).toThrow(/stepPctE18/);
  });

  it('rejects step >= 50%', () => {
    expect(() =>
      buildInfiniteGridLegs({ ...baseParams, stepPctE18: parseUnits('0.5', 18) }),
    ).toThrow(/50%/);
  });

  it('rejects zero-total levels', () => {
    expect(() =>
      buildInfiniteGridLegs({ ...baseParams, buyLevels: 0, sellLevels: 0 }),
    ).toThrow(/at least one/);
  });

  it('rejects total > 50', () => {
    expect(() =>
      buildInfiniteGridLegs({ ...baseParams, buyLevels: 26, sellLevels: 26 }),
    ).toThrow(/capped at 50/);
  });

  it('rejects baseAmountPerLevel <= 0', () => {
    expect(() =>
      buildInfiniteGridLegs({ ...baseParams, baseAmountPerLevel: 0n }),
    ).toThrow(/baseAmountPerLevel/);
  });

  it('rejects deadline too close to start', () => {
    expect(() =>
      buildInfiniteGridLegs({ ...baseParams, deadlineSec: baseParams.startSec + 100 }),
    ).toThrow(/300s/);
  });
});

describe('buildPermit2WitnessTypedData', () => {
  it('produces typed data matching UniswapX PERMIT2_ORDER_TYPE shape', () => {
    const order = buildLimitOrder({
      reactor: REACTOR,
      swapper: SWAPPER,
      side: 'sell',
      baseToken: BASE,
      quoteToken: QUOTE,
      baseAmount: parseUnits('10', 18),
      pricePerBase18: parseUnits('2', 18),
      baseDecimals: 18,
      quoteDecimals: 18,
      deadlineSec: DEADLINE,
      nonce: 99n,
    });
    const td = buildPermit2WitnessTypedData(order, { chainId: 61803, permit2: PERMIT2 });
    expect(td.primaryType).toBe('PermitWitnessTransferFrom');
    expect(td.domain.name).toBe('Permit2');
    expect(td.domain.verifyingContract).toBe(PERMIT2);
    expect(td.domain.chainId).toBe(61803);

    // Witness must flatten input — 3 fields, NOT a nested `input` tuple.
    expect(td.message.witness.inputToken).toBe(BASE);
    expect(td.message.witness.inputStartAmount).toBe(parseUnits('10', 18));
    expect(td.message.witness.inputEndAmount).toBe(parseUnits('10', 18));

    // Spender is the reactor.
    expect(td.message.spender).toBe(REACTOR);
    expect(td.message.nonce).toBe(99n);
    expect(td.message.deadline).toBe(BigInt(DEADLINE));
    expect(td.message.permitted.token).toBe(BASE);
    expect(td.message.permitted.amount).toBe(parseUnits('10', 18));

    // Sub-struct field names must match UniswapX's type strings exactly.
    const dutchOrderFields = (td.types.DutchOrder as { name: string; type: string }[]).map((f) => f.name);
    expect(dutchOrderFields).toEqual([
      'info',
      'decayStartTime',
      'decayEndTime',
      'inputToken',
      'inputStartAmount',
      'inputEndAmount',
      'outputs',
    ]);
    const outputFields = (td.types.DutchOutput as { name: string; type: string }[]).map((f) => f.name);
    expect(outputFields).toEqual(['token', 'startAmount', 'endAmount', 'recipient']);
    const infoFields = (td.types.OrderInfo as { name: string; type: string }[]).map((f) => f.name);
    expect(infoFields).toEqual([
      'reactor',
      'swapper',
      'nonce',
      'deadline',
      'additionalValidationContract',
      'additionalValidationData',
    ]);
  });
});
