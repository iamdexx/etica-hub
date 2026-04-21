import { describe, it, expect } from 'vitest';
import { decodeAbiParameters, parseAbiParameters, parseUnits, type Hex } from 'viem';
import {
  baseFromQuote,
  buildDcaLegs,
  buildLimitOrder,
  buildPermit2WitnessTypedData,
  encodeDutchOrder,
  orderBookHash,
  quoteFromBase,
  randomDcaBatchId,
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
