import { describe, expect, it } from 'vitest';
import { filterFillable } from '../src/filter.js';
import type { OrderbookOrder } from '../src/orderbook-client.js';

const REACTOR = '0x1111111111111111111111111111111111111111' as const;
const OTHER_REACTOR = '0x2222222222222222222222222222222222222222' as const;

function mkOrder(overrides: Partial<OrderbookOrder> = {}): OrderbookOrder {
  return {
    orderHash: '0xaa',
    reactor: REACTOR,
    swapper: '0x3333333333333333333333333333333333333333',
    nonce: '1',
    deadline: 2_000,
    decayStartTime: 900,
    decayEndTime: 1_500,
    input: {
      token: '0x4444444444444444444444444444444444444444',
      startAmount: '1000',
      endAmount: '1000',
    },
    output: {
      token: '0x5555555555555555555555555555555555555555',
      startAmount: '1000',
      endAmount: '950',
      recipient: '0x3333333333333333333333333333333333333333',
    },
    encodedOrder: '0xbb',
    signature: '0xcc',
    status: 'open',
    fillTxHash: null,
    fillBlockNumber: null,
    cancelTxHash: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

const BASE_ARGS = { reactor: REACTOR, now: 1_000, deadlineGraceSeconds: 30 };

describe('filterFillable', () => {
  it('keeps an open order with a future deadline and started decay', () => {
    expect(filterFillable([mkOrder()], BASE_ARGS)).toHaveLength(1);
  });

  it('drops non-open orders (filled/cancelled/expired)', () => {
    const out = filterFillable(
      [
        mkOrder({ status: 'filled' }),
        mkOrder({ status: 'cancelled' }),
        mkOrder({ status: 'expired' }),
      ],
      BASE_ARGS,
    );
    expect(out).toHaveLength(0);
  });

  it('drops orders targeting a different reactor', () => {
    expect(filterFillable([mkOrder({ reactor: OTHER_REACTOR })], BASE_ARGS)).toHaveLength(0);
  });

  it('matches reactor addresses case-insensitively', () => {
    const upper = REACTOR.toUpperCase().replace('0X', '0x') as `0x${string}`;
    expect(filterFillable([mkOrder({ reactor: upper })], BASE_ARGS)).toHaveLength(1);
  });

  it('drops orders whose deadline is inside the grace window', () => {
    const order = mkOrder({ deadline: 1_020 }); // now+20 < now+grace(30)
    expect(filterFillable([order], BASE_ARGS)).toHaveLength(0);
  });

  it('drops orders whose deadline is exactly at now+grace (boundary)', () => {
    const order = mkOrder({ deadline: 1_030 });
    expect(filterFillable([order], BASE_ARGS)).toHaveLength(0);
  });

  it('keeps orders whose deadline is just past the grace window', () => {
    const order = mkOrder({ deadline: 1_031 });
    expect(filterFillable([order], BASE_ARGS)).toHaveLength(1);
  });

  it('drops orders whose decay window has not started yet', () => {
    const order = mkOrder({ decayStartTime: 1_500 });
    expect(filterFillable([order], BASE_ARGS)).toHaveLength(0);
  });

  it('keeps orders past decayEndTime (still fillable at endAmount)', () => {
    const order = mkOrder({ decayEndTime: 500 });
    expect(filterFillable([order], BASE_ARGS)).toHaveLength(1);
  });

  it('returns empty array when input is empty', () => {
    expect(filterFillable([], BASE_ARGS)).toEqual([]);
  });
});
