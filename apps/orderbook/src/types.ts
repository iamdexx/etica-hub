/**
 * Order-book types.
 *
 * An "order" here is a signed UniswapX DutchOrder. We store the EIP-712 hash
 * as primary key, the full encoded order + signature as blobs, and enough
 * indexed fields (swapper, tokens, status, deadline) to serve keeper polls
 * efficiently.
 *
 * We do NOT re-verify signatures here — that's the reactor's job on-chain.
 * The API does cheap structural validation (addresses, non-empty sig,
 * deadlines in the future) to keep obviously-malformed junk out of the DB.
 */

export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired';

/**
 * Strategy flavor for the off-chain order book.
 *
 * On-chain the reactor sees the same DutchOrder regardless of flavor — the
 * strategy only affects **when** a keeper attempts the fill and how the UI
 * groups/displays rows:
 *   - `limit` : fill any time after `decayStartTime` while price is ≥ startAmount
 *   - `stop`  : wait for `triggerPrice` to be crossed in `triggerDirection`
 *               before attempting the fill (keeper-enforced, off-chain).
 *   - `dca`   : one leg of a dollar-cost-average batch. Identical gating to
 *               `limit` (decayStartTime acts as the "execute after" timestamp
 *               per leg), but carries `dcaBatchId`/`dcaIndex`/`dcaTotal` so
 *               the UI can group legs into a single strategy row.
 *   - `grid`  : one level of a bounded grid. Each level is functionally a
 *               limit order at its own `gridLevelPrice` (buy-below / sell-above
 *               the reference price at signing time). The batch shares a
 *               `gridBatchId` so the dashboard can group levels as one row.
 *               Infinite grids ride on top by re-signing new upper levels as
 *               price climbs; they reuse the same strategy type.
 */
export type StrategyType = 'limit' | 'stop' | 'dca' | 'grid';

/** Trigger direction for stop orders. `lte` = stop-loss, `gte` = buy-stop. */
export type TriggerDirection = 'lte' | 'gte';

export interface StoredOrder {
  /** EIP-712 hash of the order (0x-prefixed hex, 32 bytes). */
  orderHash: `0x${string}`;

  /** Reactor contract address this order targets. */
  reactor: `0x${string}`;

  /** Address that signed the order (the trader). */
  swapper: `0x${string}`;

  /** Permit2 nonce used — also the cancellation key. */
  nonce: string;

  /** Unix seconds — after this the order is unfillable on-chain. */
  deadline: number;

  /** Decay window. */
  decayStartTime: number;
  decayEndTime: number;

  /** Input token address + start/end amounts (stringified bigint). */
  inputToken: `0x${string}`;
  inputStartAmount: string;
  inputEndAmount: string;

  /** For multi-output orders we index only the first output (common case). */
  outputToken: `0x${string}`;
  outputStartAmount: string;
  outputEndAmount: string;
  outputRecipient: `0x${string}`;

  /** ABI-encoded DutchOrder struct (the `order` blob you pass to reactor.execute). */
  encodedOrder: `0x${string}`;

  /** EIP-712 signature from the swapper, as `v||r||s` 65-byte hex. */
  signature: `0x${string}`;

  status: OrderStatus;

  /** `limit` (default) or `stop`. Affects keeper fill gating only. */
  strategyType: StrategyType;

  /**
   * Stop-order trigger price, expressed as ETX-per-base with 18 decimals
   * (stringified bigint). Null for limit orders.
   */
  triggerPrice: string | null;

  /** `lte` for stop-loss (price ≤ trigger), `gte` for buy-stop. Null for limit. */
  triggerDirection: TriggerDirection | null;

  /**
   * DCA batch grouping. Populated only for `strategyType === 'dca'`. The
   * `dcaBatchId` is a client-generated UUID shared by every leg of one DCA
   * plan; `dcaIndex` is the 0-based position in the schedule; `dcaTotal` is
   * the total number of legs. Legacy rows / non-DCA orders have all three
   * as null.
   */
  dcaBatchId: string | null;
  dcaIndex: number | null;
  dcaTotal: number | null;

  /**
   * Grid batch grouping. Populated only for `strategyType === 'grid'`. The
   * `gridBatchId` is a client-generated UUID shared by every level of one
   * grid plan; `gridIndex` is the 0-based position (lowest-priced level = 0,
   * sorted ascending); `gridTotal` is the total number of levels;
   * `gridLevelPrice` is the ETX-per-base limit price of that level (stringified
   * 1e18-scaled bigint) so the UI can render "buy @ 1.40 ETX" per row. Legacy
   * rows / non-grid orders have all four as null.
   */
  gridBatchId: string | null;
  gridIndex: number | null;
  gridTotal: number | null;
  gridLevelPrice: string | null;

  /** Populated after a keeper lands a fill tx. */
  fillTxHash: `0x${string}` | null;
  fillBlockNumber: number | null;

  /** Populated when a user submits a signed cancel. */
  cancelTxHash: `0x${string}` | null;

  createdAt: string;
  updatedAt: string;
}

export interface OrderFilter {
  status?: OrderStatus;
  swapper?: `0x${string}`;
  inputToken?: `0x${string}`;
  outputToken?: `0x${string}`;
  strategyType?: StrategyType;
  /** Filter to a single DCA batch (used by UI grouping). */
  dcaBatchId?: string;
  /** Filter to a single grid batch (used by UI grouping). */
  gridBatchId?: string;
  /** Only orders whose deadline is >= this unix timestamp. */
  minDeadline?: number;
  limit?: number;
  offset?: number;
}
