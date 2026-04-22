/**
 * Server-side helpers for the /explorer/gas page.
 *
 * The explorer shows two classes of gas information:
 *   1. A point-in-time "current" number from `eth_gasPrice` — what a
 *      simple wallet would quote for a legacy tx right now.
 *   2. A per-block time-series over the last N blocks covering base fee
 *      (the EIP-1559 floor), gas used vs gas limit (network load), and
 *      the average priority fee included in that block's txs.
 *
 * Everything here is computed at request time from the public RPC; no
 * indexer is required. The time-series is bounded to a small window
 * (default 50 blocks ≈ a few minutes on Etica) so that even worst-case
 * fan-out stays well within Vercel's function timeout.
 */
import {
  formatUnits,
  type Block,
  type PublicClient,
  type Transaction,
} from 'viem';

/** Width of the per-block time-series window on the gas page. */
export const GAS_STATS_WINDOW = 50;

/** One row of the per-block gas time-series. */
export interface GasBlockStat {
  number: bigint;
  timestamp: bigint;
  /** EIP-1559 base fee for the block in wei. `null` for pre-1559 chains. */
  baseFeePerGasWei: bigint | null;
  gasUsed: bigint;
  gasLimit: bigint;
  /**
   * Arithmetic mean of `maxPriorityFeePerGas` across the block's txs.
   * For legacy txs we fall back to `effectivePriorityFee = gasPrice -
   * baseFeePerGas` (bounded at 0). `null` if the block has zero txs.
   */
  avgPriorityFeeWei: bigint | null;
  /** Count of txs in the block. */
  txCount: number;
}

/** Aggregate stats derived from a `GasBlockStat[]` window. */
export interface GasStatsSummary {
  /** Head number at sample time. */
  head: bigint;
  /** `eth_gasPrice` in wei at sample time. */
  currentGasPriceWei: bigint;
  /** EIP-1559 base fee at the head block, or `null`. */
  headBaseFeeWei: bigint | null;
  /** Rolling stats over the window. `null` when the window is empty. */
  avgBaseFeeWei: bigint | null;
  minBaseFeeWei: bigint | null;
  maxBaseFeeWei: bigint | null;
  avgGasUsedRatio: number;
  blocks: GasBlockStat[];
}

/**
 * Loads the current gas price, head block, and the last
 * `GAS_STATS_WINDOW` blocks' gas stats. All RPC fan-out is done in
 * parallel per block.
 *
 * Silent failure policy: if any individual block fetch rejects we drop
 * that block from the series rather than failing the whole page. The
 * summary is computed from whatever we did load. The current-gas-price
 * call is required — a chain without `eth_gasPrice` can't render this
 * page at all.
 */
export async function loadGasStats(
  client: PublicClient,
): Promise<GasStatsSummary> {
  const [head, currentGasPriceWei] = await Promise.all([
    client.getBlockNumber(),
    client.getGasPrice(),
  ]);
  const start =
    head >= BigInt(GAS_STATS_WINDOW) ? head - BigInt(GAS_STATS_WINDOW - 1) : 0n;
  const numbers: bigint[] = [];
  for (let n = start; n <= head; n++) numbers.push(n);

  const results = await Promise.all(
    numbers.map((n) =>
      client
        .getBlock({ blockNumber: n, includeTransactions: true })
        .then((b) => b as Block & { transactions: Transaction[] })
        .then(computeBlockStat)
        .catch(() => null),
    ),
  );
  const blocks = results.filter((x): x is GasBlockStat => x != null);
  blocks.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));

  const headBaseFeeWei =
    blocks.length > 0 ? blocks[blocks.length - 1].baseFeePerGasWei : null;
  return {
    head,
    currentGasPriceWei,
    headBaseFeeWei,
    ...summarize(blocks),
    blocks,
  };
}

/**
 * Computes one row of the time-series from a block with inlined txs.
 * Exported so unit tests can exercise the priority-fee math without
 * mocking an entire RPC round-trip.
 */
export function computeBlockStat(
  block: Block & { transactions: Transaction[] },
): GasBlockStat {
  const baseFee = block.baseFeePerGas ?? null;
  const txCount = block.transactions.length;
  const avgPriorityFeeWei =
    txCount > 0
      ? averagePriorityFee(block.transactions, baseFee ?? 0n)
      : null;
  return {
    number: block.number!,
    timestamp: block.timestamp,
    baseFeePerGasWei: baseFee,
    gasUsed: block.gasUsed,
    gasLimit: block.gasLimit,
    avgPriorityFeeWei,
    txCount,
  };
}

/**
 * Per-tx priority fee estimate. For EIP-1559 txs with an explicit
 * `maxPriorityFeePerGas` we use that directly — it's the exact tip the
 * sender committed to. For legacy txs we use
 * `max(0, gasPrice - baseFeePerGas)` which is what the validator
 * actually captured.
 */
function averagePriorityFee(txs: Transaction[], baseFee: bigint): bigint {
  let sum = 0n;
  let n = 0n;
  for (const tx of txs) {
    const tip = priorityFeeForTx(tx, baseFee);
    if (tip == null) continue;
    sum += tip;
    n += 1n;
  }
  return n === 0n ? 0n : sum / n;
}

function priorityFeeForTx(tx: Transaction, baseFee: bigint): bigint | null {
  const maxPriority = (tx as { maxPriorityFeePerGas?: bigint | null })
    .maxPriorityFeePerGas;
  if (typeof maxPriority === 'bigint') return maxPriority;
  const gasPrice = (tx as { gasPrice?: bigint | null }).gasPrice;
  if (typeof gasPrice === 'bigint') {
    const tip = gasPrice - baseFee;
    return tip > 0n ? tip : 0n;
  }
  return null;
}

function summarize(blocks: GasBlockStat[]): {
  avgBaseFeeWei: bigint | null;
  minBaseFeeWei: bigint | null;
  maxBaseFeeWei: bigint | null;
  avgGasUsedRatio: number;
} {
  let sumFee = 0n;
  let nFee = 0n;
  let minFee: bigint | null = null;
  let maxFee: bigint | null = null;
  let sumRatio = 0;
  let nRatio = 0;
  for (const b of blocks) {
    if (b.baseFeePerGasWei != null) {
      sumFee += b.baseFeePerGasWei;
      nFee += 1n;
      if (minFee == null || b.baseFeePerGasWei < minFee) {
        minFee = b.baseFeePerGasWei;
      }
      if (maxFee == null || b.baseFeePerGasWei > maxFee) {
        maxFee = b.baseFeePerGasWei;
      }
    }
    if (b.gasLimit > 0n) {
      sumRatio += Number(b.gasUsed) / Number(b.gasLimit);
      nRatio += 1;
    }
  }
  return {
    avgBaseFeeWei: nFee > 0n ? sumFee / nFee : null,
    minBaseFeeWei: minFee,
    maxBaseFeeWei: maxFee,
    avgGasUsedRatio: nRatio > 0 ? sumRatio / nRatio : 0,
  };
}

/**
 * Formats a wei gas-price value in gwei with a reasonable number of
 * fractional digits. Accepts `null` for absent base fees etc.
 */
export function formatGwei(wei: bigint | null | undefined): string {
  if (wei == null) return '—';
  const gwei = formatUnits(wei, 9);
  const [intPart, fracPart = ''] = gwei.split('.');
  // 3 fractional digits is enough for anything ≥ 1 gwei; below that,
  // extend to 6 so sub-gwei prices stay legible.
  const digits = intPart === '0' ? 6 : 3;
  const short = fracPart.slice(0, digits).replace(/0+$/, '');
  return short ? `${intPart}.${short}` : intPart;
}
