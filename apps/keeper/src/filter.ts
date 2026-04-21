/**
 * Pure order-filtering logic for the keeper loop.
 *
 * Kept in its own module (no viem/network deps) so it's trivially unit-testable.
 */

import type { Address } from 'viem';
import type { OrderbookOrder } from './orderbook-client.js';

export interface FilterArgs {
  /** Reactor this keeper serves. Orders for other reactors are ignored. */
  reactor: Address;

  /** Current unix seconds. */
  now: number;

  /**
   * Grace window before deadline: we drop orders whose deadline is < now + grace
   * so we don't waste RPC calls simulating fills that will revert on-chain.
   */
  deadlineGraceSeconds: number;
}

/**
 * Returns only orders this keeper should attempt to fill:
 *  - status === 'open'
 *  - reactor address matches
 *  - deadline is comfortably in the future
 *  - decay window has started (decayStartTime <= now)
 *
 * Orders past their decayEndTime are still eligible (they fill at endAmount),
 * so we DON'T filter on decayEndTime — only deadline.
 */
export function filterFillable(orders: OrderbookOrder[], args: FilterArgs): OrderbookOrder[] {
  const reactor = args.reactor.toLowerCase();
  const cutoff = args.now + args.deadlineGraceSeconds;

  return orders.filter((o) => {
    if (o.status !== 'open') return false;
    if (o.reactor.toLowerCase() !== reactor) return false;
    if (o.deadline <= cutoff) return false;
    if (o.decayStartTime > args.now) return false;
    return true;
  });
}
