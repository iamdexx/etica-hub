/**
 * Thin client for the order-book HTTP API.
 *
 * Only covers the endpoints the keeper uses:
 *   GET  /orders?status=open&...   — poll for fillable orders
 *   POST /orders/:hash/mark-filled — report a landed fill tx (auth-gated)
 *
 * The keeper does NOT submit new orders or cancel — those are user actions.
 */

import type { Address, Hex } from 'viem';

export interface OrderbookOrder {
  orderHash: Hex;
  reactor: Address;
  swapper: Address;
  nonce: string;
  deadline: number;
  decayStartTime: number;
  decayEndTime: number;
  input: {
    token: Address;
    startAmount: string;
    endAmount: string;
  };
  output: {
    token: Address;
    startAmount: string;
    endAmount: string;
    recipient: Address;
  };
  encodedOrder: Hex;
  signature: Hex;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  fillTxHash: Hex | null;
  fillBlockNumber: number | null;
  cancelTxHash: Hex | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListOrdersParams {
  status?: 'open' | 'filled' | 'cancelled' | 'expired';
  swapper?: Address;
  inputToken?: Address;
  outputToken?: Address;
  minDeadline?: number;
  limit?: number;
  offset?: number;
}

export interface OrderbookClient {
  listOrders(params?: ListOrdersParams): Promise<OrderbookOrder[]>;
  markFilled(orderHash: Hex, fillTxHash: Hex, fillBlockNumber: number): Promise<void>;
}

export interface OrderbookClientOptions {
  baseUrl: string;
  keeperAuthToken?: string | null;
  /** Allow injecting a custom fetch for tests. */
  fetchImpl?: typeof fetch;
}

export function createOrderbookClient(opts: OrderbookClientOptions): OrderbookClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async listOrders(params: ListOrdersParams = {}): Promise<OrderbookOrder[]> {
      const qs = new URLSearchParams();
      if (params.status) qs.set('status', params.status);
      if (params.swapper) qs.set('swapper', params.swapper);
      if (params.inputToken) qs.set('inputToken', params.inputToken);
      if (params.outputToken) qs.set('outputToken', params.outputToken);
      if (typeof params.minDeadline === 'number') qs.set('minDeadline', String(params.minDeadline));
      if (typeof params.limit === 'number') qs.set('limit', String(params.limit));
      if (typeof params.offset === 'number') qs.set('offset', String(params.offset));

      const url = `${baseUrl}/orders${qs.size ? `?${qs.toString()}` : ''}`;
      const res = await doFetch(url, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`listOrders ${res.status}: ${await res.text().catch(() => '')}`);
      }
      const body = (await res.json()) as { orders: OrderbookOrder[] };
      return Array.isArray(body?.orders) ? body.orders : [];
    },

    async markFilled(orderHash: Hex, fillTxHash: Hex, fillBlockNumber: number): Promise<void> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.keeperAuthToken) headers['X-Keeper-Auth'] = opts.keeperAuthToken;

      const res = await doFetch(`${baseUrl}/orders/${orderHash}/mark-filled`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fillTxHash, fillBlockNumber }),
      });
      if (!res.ok) {
        throw new Error(`markFilled ${res.status}: ${await res.text().catch(() => '')}`);
      }
    },
  };
}
