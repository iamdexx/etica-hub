/**
 * Row types emitted by the explorer indexer.
 *
 * Every field is serializable to JSON — bigints are encoded as decimal
 * strings so JSONL files can be read back without custom revivers.
 * Addresses are always lowercase to make filtering/joining trivial.
 */

export interface TransferRow {
  /** Block number (decimal). */
  block: number;
  /** Block timestamp (unix seconds). */
  ts: number;
  /** Transaction hash (0x-prefixed, lowercase). */
  tx: string;
  /** Log index within the block. */
  logIndex: number;
  /** Emitting token contract (lowercase 0x address). */
  token: string;
  /** Sender (lowercase). `0x00…` for mints. */
  from: string;
  /** Recipient (lowercase). `0x00…` for burns. */
  to: string;
  /** Transferred amount, as a decimal string of the raw on-chain integer. */
  value: string;
}

export interface SyncRow {
  block: number;
  ts: number;
  tx: string;
  logIndex: number;
  /** V2 pair address (lowercase). */
  pair: string;
  /** Reserve of pair.token0 as a decimal string. */
  reserve0: string;
  /** Reserve of pair.token1 as a decimal string. */
  reserve1: string;
}

/**
 * Resumable index cursor. Points at the last block fully processed;
 * on the next run we resume from `lastBlock + 1`. Stored as a single
 * JSON file at the root of the data branch.
 */
export interface IndexCursor {
  /** Last block fully processed (inclusive). */
  lastBlock: number;
  /** Chain id — sanity-check against current env on resume. */
  chainId: number;
  /** ISO timestamp of the most recent successful run. */
  updatedAt: string;
  /** Monotonic run counter. */
  runs: number;
  /** Total rows ever emitted (cumulative across runs). */
  cumulative: {
    transfers: number;
    syncs: number;
  };
}

/** Standard ERC-20 Transfer event topic0. */
export const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** UniswapV2 Pair Sync(uint112,uint112) topic0. */
export const SYNC_TOPIC0 =
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
