/**
 * One-shot run loop for the explorer indexer.
 *
 * Design:
 *   - Read the cursor; if missing, start at `INDEX_START_BLOCK` (default
 *     = head - INDEX_INITIAL_LOOKBACK) so the first run is bounded.
 *   - Scan forward in `INDEX_BLOCK_BATCH` chunks until we either reach
 *     head or hit `INDEX_MAX_BLOCKS_PER_RUN`. Keeping a per-run cap means
 *     a single cron run never exceeds the workflow's wall-clock budget.
 *   - For each chunk, fetch Transfer + Sync logs (two parallel
 *     eth_getLogs calls), fetch the chunk's blocks (for timestamps) in
 *     parallel, decode rows, append to JSONL files.
 *   - Save the cursor at the end, atomically.
 *
 * Idempotency: if the run crashes mid-chunk, the next run re-scans from
 * `cursor.lastBlock + 1`. Rows in the half-written chunk may be
 * duplicated on retry — downstream consumers should dedupe by
 * `(block, logIndex)`. We don't de-dupe on write because that would
 * require reading the full JSONL back on every run.
 */
import { createPublicClient, http, type Block, type Log, type PublicClient } from 'viem';
import { eticaMainnet } from '@etica-hub/shared';
import {
  DEFAULT_DATA_DIR,
  appendSyncs,
  appendTransfers,
  loadCursor,
  saveCursor,
} from './io.js';
import { decodeSync, decodeTransfer } from './scan.js';
import {
  SYNC_TOPIC0,
  TRANSFER_TOPIC0,
  type IndexCursor,
  type SyncRow,
  type TransferRow,
} from './types.js';

export interface RunConfig {
  dataDir: string;
  rpcUrl?: string;
  /**
   * Number of blocks to scan per eth_getLogs call. Etica's public RPC
   * has historically handled 2000-block ranges without issue; tune
   * down if you see request-timeout errors.
   */
  blockBatchSize: number;
  /**
   * Upper bound on blocks processed per run. Prevents a cold-start
   * run from trying to backfill months of history in one job. Tune up
   * for manual backfills, leave small for cron.
   */
  maxBlocksPerRun: number;
  /**
   * Fallback start block when cursor.json is missing. We default to
   * `head - initialLookback` so a fresh deploy doesn't try to walk
   * the entire chain from block 0.
   */
  initialLookback: bigint;
}

export async function runIndexerOnce(
  cfg: RunConfig,
): Promise<{ processed: number; transfers: number; syncs: number; cursor: IndexCursor }> {
  const client = createPublicClient({
    chain: eticaMainnet,
    transport: cfg.rpcUrl ? http(cfg.rpcUrl) : http(),
  }) as PublicClient;

  const head = await client.getBlockNumber();
  const prev = loadCursor(cfg.dataDir);
  const startBlock =
    prev != null
      ? BigInt(prev.lastBlock) + 1n
      : head > cfg.initialLookback
        ? head - cfg.initialLookback
        : 0n;
  if (startBlock > head) {
    // Already caught up; update updatedAt + bail.
    const cursor: IndexCursor = prev
      ? { ...prev, updatedAt: new Date().toISOString(), runs: prev.runs + 1 }
      : {
          lastBlock: Number(head),
          chainId: eticaMainnet.id,
          updatedAt: new Date().toISOString(),
          runs: 1,
          cumulative: { transfers: 0, syncs: 0 },
        };
    saveCursor(cfg.dataDir, cursor);
    return { processed: 0, transfers: 0, syncs: 0, cursor };
  }

  const budgetEnd =
    head - startBlock + 1n > BigInt(cfg.maxBlocksPerRun)
      ? startBlock + BigInt(cfg.maxBlocksPerRun) - 1n
      : head;

  let totalTransfers = 0;
  let totalSyncs = 0;
  let processed = 0;
  let cursorBlock = startBlock - 1n;

  for (let from = startBlock; from <= budgetEnd; from += BigInt(cfg.blockBatchSize)) {
    const to = from + BigInt(cfg.blockBatchSize) - 1n > budgetEnd ? budgetEnd : from + BigInt(cfg.blockBatchSize) - 1n;

    // Server-side topic0 filter: without this, most RPC providers
    // enforce a max-results limit (commonly 10k) and either error or
    // silently truncate when a 1k-block window contains more logs
    // than the cap — causing missed Transfer/Sync events.
    const transferParams = {
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC0],
    };
    const syncParams = {
      fromBlock: from,
      toBlock: to,
      topics: [SYNC_TOPIC0],
    };
    const [transferLogs, syncLogs] = (await Promise.all([
      // viem's typed getLogs overload doesn't accept raw `topics`; the
      // cast is only to get the field through to eth_getLogs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.getLogs(transferParams as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.getLogs(syncParams as any),
    ])) as [Log[], Log[]];

    const neededBlocks = new Set<bigint>();
    for (const l of transferLogs) if (l.blockNumber != null) neededBlocks.add(l.blockNumber);
    for (const l of syncLogs) if (l.blockNumber != null) neededBlocks.add(l.blockNumber);

    const blocks = await Promise.all(
      Array.from(neededBlocks).map((n) =>
        client.getBlock({ blockNumber: n, includeTransactions: false }),
      ),
    );
    const tsByBlock = new Map<bigint, number>();
    for (const b of blocks as Block[]) {
      if (b.number != null) tsByBlock.set(b.number, Number(b.timestamp));
    }

    const transfers: TransferRow[] = [];
    for (const l of transferLogs) {
      if (l.blockNumber == null) continue;
      const ts = tsByBlock.get(l.blockNumber);
      if (ts == null) continue;
      const row = decodeTransfer(l, ts);
      if (row != null) transfers.push(row);
    }
    const syncs: SyncRow[] = [];
    for (const l of syncLogs) {
      if (l.blockNumber == null) continue;
      const ts = tsByBlock.get(l.blockNumber);
      if (ts == null) continue;
      const row = decodeSync(l, ts);
      if (row != null) syncs.push(row);
    }

    appendTransfers(cfg.dataDir, transfers);
    appendSyncs(cfg.dataDir, syncs);

    totalTransfers += transfers.length;
    totalSyncs += syncs.length;
    processed += Number(to - from + 1n);
    cursorBlock = to;
  }

  const cumulative = prev?.cumulative ?? { transfers: 0, syncs: 0 };
  const cursor: IndexCursor = {
    lastBlock: Number(cursorBlock),
    chainId: eticaMainnet.id,
    updatedAt: new Date().toISOString(),
    runs: (prev?.runs ?? 0) + 1,
    cumulative: {
      transfers: cumulative.transfers + totalTransfers,
      syncs: cumulative.syncs + totalSyncs,
    },
  };
  saveCursor(cfg.dataDir, cursor);
  return { processed, transfers: totalTransfers, syncs: totalSyncs, cursor };
}

/** Entry-point used by the indexer CLI when `INDEXER_MODULE=explorer`. */
export async function runExplorerIndexer(): Promise<void> {
  const cfg: RunConfig = {
    dataDir: process.env.INDEX_DATA_DIR ?? DEFAULT_DATA_DIR,
    rpcUrl: process.env.ETICA_MAINNET_RPC_URL,
    blockBatchSize: parseInt(process.env.INDEX_BLOCK_BATCH ?? '1000', 10),
    maxBlocksPerRun: parseInt(process.env.INDEX_MAX_BLOCKS_PER_RUN ?? '5000', 10),
    initialLookback: BigInt(process.env.INDEX_INITIAL_LOOKBACK ?? '10000'),
  };
  const start = Date.now();
  const result = await runIndexerOnce(cfg);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'explorer.indexed',
      durationMs: Date.now() - start,
      blocksProcessed: result.processed,
      newTransfers: result.transfers,
      newSyncs: result.syncs,
      cursor: result.cursor,
    }),
  );
}
