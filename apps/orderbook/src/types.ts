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
  /** Only orders whose deadline is >= this unix timestamp. */
  minDeadline?: number;
  limit?: number;
  offset?: number;
}
