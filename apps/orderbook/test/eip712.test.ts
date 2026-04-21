import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { DUTCH_ORDER_ABI_TYPE, decodeDutchOrder, validateOrderStructure } from '../src/eip712.js';

const REACTOR = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const SWAPPER = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const TOKEN_IN = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const TOKEN_OUT = '0x4444444444444444444444444444444444444444' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const GOOD_SIG = `0x${'ab'.repeat(65)}` as `0x${string}`;

function makeEncodedOrder(overrides?: Partial<{ deadline: bigint; decayStartTime: bigint; decayEndTime: bigint; inputStart: bigint; outputs: unknown[] }>) {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deadline = overrides?.deadline ?? nowSec + 3600n;
  const decayStartTime = overrides?.decayStartTime ?? nowSec;
  const decayEndTime = overrides?.decayEndTime ?? nowSec + 60n;

  const outputs = overrides?.outputs ?? [
    { token: TOKEN_OUT, startAmount: 1_000_000n, endAmount: 900_000n, recipient: SWAPPER },
  ];

  const order = {
    info: {
      reactor: REACTOR,
      swapper: SWAPPER,
      nonce: 42n,
      deadline,
      additionalValidationContract: ZERO,
      additionalValidationData: '0x' as `0x${string}`,
    },
    decayStartTime,
    decayEndTime,
    input: {
      token: TOKEN_IN,
      startAmount: overrides?.inputStart ?? 500_000n,
      endAmount: 500_000n,
    },
    outputs,
  };

  return encodeAbiParameters([DUTCH_ORDER_ABI_TYPE], [order]);
}

describe('decodeDutchOrder', () => {
  it('round-trips a canonical order', () => {
    const encoded = makeEncodedOrder();
    const decoded = decodeDutchOrder(encoded);
    expect(decoded.reactor).toBe(REACTOR);
    expect(decoded.swapper).toBe(SWAPPER);
    expect(decoded.nonce).toBe(42n);
    expect(decoded.input.token).toBe(TOKEN_IN);
    expect(decoded.outputs).toHaveLength(1);
    expect(decoded.outputs[0]?.token).toBe(TOKEN_OUT);
    expect(decoded.outputs[0]?.recipient).toBe(SWAPPER);
  });
});

describe('validateOrderStructure', () => {
  it('accepts a well-formed order', () => {
    const decoded = decodeDutchOrder(makeEncodedOrder());
    expect(validateOrderStructure(decoded, GOOD_SIG)).toBeNull();
  });

  it('rejects an expired order', () => {
    const expired = BigInt(Math.floor(Date.now() / 1000)) - 60n;
    const decoded = decodeDutchOrder(
      makeEncodedOrder({ deadline: expired, decayEndTime: expired }),
    );
    expect(validateOrderStructure(decoded, GOOD_SIG)).toMatch(/deadline/);
  });

  it('rejects a malformed signature', () => {
    const decoded = decodeDutchOrder(makeEncodedOrder());
    expect(validateOrderStructure(decoded, '0xdead' as `0x${string}`)).toMatch(/signature/);
  });

  it('rejects an order with zero outputs', () => {
    const decoded = decodeDutchOrder(makeEncodedOrder({ outputs: [] }));
    expect(validateOrderStructure(decoded, GOOD_SIG)).toMatch(/at least one output/);
  });

  it('rejects an order with zero input start amount', () => {
    const decoded = decodeDutchOrder(makeEncodedOrder({ inputStart: 0n }));
    expect(validateOrderStructure(decoded, GOOD_SIG)).toMatch(/input/);
  });

  it('rejects an order with decayEndTime > deadline', () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const decoded = decodeDutchOrder(
      makeEncodedOrder({ deadline: nowSec + 60n, decayEndTime: nowSec + 120n }),
    );
    expect(validateOrderStructure(decoded, GOOD_SIG)).toMatch(/decayEndTime/);
  });
});
