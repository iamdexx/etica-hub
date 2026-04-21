import type { Address, Hex } from 'viem';

/**
 * Thin fetch client for the order-book API (`apps/orderbook`).
 *
 * Keeps the API surface narrow on purpose:
 *   - POST /orders  → submit a fresh signed order
 *   - GET  /orders  → list, filtered by swapper + status
 *   - POST /orders/:hash/cancel → mark cancelled (requires an on-chain cancel
 *     tx hash; the keeper won't fill a marked-cancelled order even if the
 *     on-chain nonce invalidation hasn't landed yet).
 *
 * The client deliberately does NOT try to interpret on-chain fill status or
 * nonce state — those belong to the keeper and the user's wallet, not the UI.
 */

export interface StoredOrderView {
  orderHash: Hex;
  reactor: Address;
  swapper: Address;
  nonce: string;
  deadline: number;
  decayStartTime: number;
  decayEndTime: number;
  input: { token: Address; startAmount: string; endAmount: string };
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
  // ISO-8601 datetime strings produced by the orderbook API (SQLite
  // `datetime('now')`), e.g. `"2024-01-15T12:34:56.789Z"`.
  createdAt: string;
  updatedAt: string;
}

export class OrderbookError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OrderbookError';
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit & { parseJson?: boolean },
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new OrderbookError(0, 'network', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    let detail: string = `${res.status} ${res.statusText}`;
    let code = 'http_error';
    try {
      const body = (await res.json()) as { error?: string; detail?: unknown };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      // non-JSON response; keep the default detail.
    }
    throw new OrderbookError(res.status, code, detail);
  }
  if (init?.parseJson === false) return undefined as T;
  return (await res.json()) as T;
}

export interface SubmitOrderInput {
  encodedOrder: Hex;
  signature: Hex;
}

export async function submitOrder(
  baseUrl: string,
  body: SubmitOrderInput,
): Promise<StoredOrderView> {
  return request<StoredOrderView>(baseUrl, '/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface ListOrdersParams {
  swapper?: Address;
  status?: 'open' | 'filled' | 'cancelled' | 'expired';
  reactor?: Address;
  limit?: number;
}

export async function listOrders(
  baseUrl: string,
  params: ListOrdersParams = {},
): Promise<StoredOrderView[]> {
  const q = new URLSearchParams();
  if (params.swapper) q.set('swapper', params.swapper);
  if (params.status) q.set('status', params.status);
  if (params.reactor) q.set('reactor', params.reactor);
  if (params.limit != null) q.set('limit', String(params.limit));
  const suffix = q.toString() ? `?${q.toString()}` : '';
  const out = await request<{ orders: StoredOrderView[] }>(baseUrl, `/orders${suffix}`);
  return out.orders;
}

export async function markCancelled(
  baseUrl: string,
  orderHash: Hex,
  cancelTxHash: Hex,
): Promise<StoredOrderView> {
  return request<StoredOrderView>(
    baseUrl,
    `/orders/${orderHash}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancelTxHash }),
    },
  );
}

/** Read `NEXT_PUBLIC_ORDERBOOK_URL` at runtime. Returns null if unset so
 * callers can render a "trading backend is offline" banner instead of
 * crashing. */
export function resolveOrderbookUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_ORDERBOOK_URL;
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return url;
}
