import type { PublicClient } from 'viem';
import { parseAbiItem, decodeEventLog, formatUnits } from 'viem';
import { abis } from '@etica-hub/shared';
import type { PriceDb } from './db';

/**
 * Describes a single V2 pool we track.
 *
 * `baseToken` / `quoteToken` identify which side of the pair we treat as
 * "base" (the asset we're pricing) and "quote" (the asset the price is
 * denominated in). For our hub-and-spoke, every pool is `<spoke>/ETX`, so
 * ETX is always the quote. Price = reserveQuote / reserveBase.
 */
export interface TrackedPair {
  pairId: string;
  pairAddress: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface PriceIndexerConfig {
  client: PublicClient;
  db: PriceDb;
  pairs: TrackedPair[];
  /** How many blocks to scan per tick. */
  blockBatchSize: number;
  /** Starting block if the cursor is empty. */
  startBlock: bigint;
  pollIntervalMs: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface PriceIndexer {
  tick(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
}

const swapEventAbi = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);

/**
 * Computes the effective executed price of a single swap.
 *
 * Uniswap V2 always has exactly one "in" side and one "out" side for a given
 * token (amount0In+amount0Out > 0 on one side, the other side is the inverse).
 * Volume is the input amount on one side and the output amount on the other.
 *
 * Returned price is `quoteToken per 1 baseToken`, in fixed-18 scaled integer
 * string (so 1.234 quote per base is "1234000000000000000"). Using a 1e18
 * scale avoids float imprecision while keeping arithmetic trivial downstream.
 */
export function priceFromSwap(
  amount0In: bigint,
  amount1In: bigint,
  amount0Out: bigint,
  amount1Out: bigint,
  token0IsBase: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): { price18: string; baseAmount: bigint; quoteAmount: bigint } | null {
  // Identify how much base flowed in or out and how much quote.
  let baseAmount: bigint;
  let quoteAmount: bigint;

  if (token0IsBase) {
    // base = token0, quote = token1
    // Scenario: swap base-in -> quote-out  =>  baseAmount = amount0In,  quoteAmount = amount1Out
    // Scenario: swap quote-in -> base-out  =>  baseAmount = amount0Out, quoteAmount = amount1In
    if (amount0In > 0n && amount1Out > 0n) {
      baseAmount = amount0In;
      quoteAmount = amount1Out;
    } else if (amount1In > 0n && amount0Out > 0n) {
      baseAmount = amount0Out;
      quoteAmount = amount1In;
    } else {
      return null;
    }
  } else {
    // base = token1, quote = token0
    if (amount1In > 0n && amount0Out > 0n) {
      baseAmount = amount1In;
      quoteAmount = amount0Out;
    } else if (amount0In > 0n && amount1Out > 0n) {
      baseAmount = amount1Out;
      quoteAmount = amount0In;
    } else {
      return null;
    }
  }

  if (baseAmount === 0n) return null;

  // price18 = (quoteAmount * 10^(18 + baseDecimals - quoteDecimals)) / baseAmount
  // Rearranged so the numerator stays positive-integer regardless of decimal diff.
  const scaleExponent = 18 + baseDecimals - quoteDecimals;
  let num = quoteAmount;
  let den = baseAmount;
  if (scaleExponent >= 0) {
    num = num * 10n ** BigInt(scaleExponent);
  } else {
    den = den * 10n ** BigInt(-scaleExponent);
  }
  const price18 = num / den;
  return { price18: price18.toString(), baseAmount, quoteAmount };
}

/** Rounds a unix-seconds timestamp down to the nearest minute. */
export function bucketOf(tsSec: number): number {
  return Math.floor(tsSec / 60) * 60;
}

export function createPriceIndexer(config: PriceIndexerConfig): PriceIndexer {
  const logger = config.logger ?? console;
  let stopped = false;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let waiter: { resolve: () => void } | null = null;

  async function tickOne(pair: TrackedPair): Promise<void> {
    const cursor = BigInt(config.db.getCursor(pair.pairId));
    const from = cursor === 0n ? config.startBlock : cursor + 1n;
    const latest = await config.client.getBlockNumber();
    if (from > latest) return;

    const batchEnd = from + BigInt(config.blockBatchSize) - 1n;
    const to = batchEnd < latest ? batchEnd : latest;

    const logs = await config.client.getLogs({
      address: pair.pairAddress,
      event: swapEventAbi,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      const decoded = decodeEventLog({
        abi: abis.pairAbi,
        data: log.data,
        topics: log.topics,
        eventName: 'Swap',
      });
      const args = decoded.args as unknown as {
        amount0In: bigint;
        amount1In: bigint;
        amount0Out: bigint;
        amount1Out: bigint;
      };
      const token0IsBase = pair.token0.toLowerCase() === pair.baseToken.toLowerCase();
      const result = priceFromSwap(
        args.amount0In,
        args.amount1In,
        args.amount0Out,
        args.amount1Out,
        token0IsBase,
        pair.baseDecimals,
        pair.quoteDecimals,
      );
      if (!result) continue;

      const block = await config.client.getBlock({ blockNumber: log.blockNumber });
      const ts = Number(block.timestamp);
      const bucket = bucketOf(ts);

      config.db.applySwap(
        pair.pairId,
        bucket,
        result.price18,
        result.baseAmount.toString(),
        result.quoteAmount.toString(),
      );

      const priceQuotePerBase = result.price18;
      // inverse = 10^36 / price18; if price18 is 0 this is undefined.
      const priceBasePerQuote =
        BigInt(priceQuotePerBase) === 0n
          ? '0'
          : (10n ** 36n / BigInt(priceQuotePerBase)).toString();

      config.db.setLatestPrice({
        pairId: pair.pairId,
        baseToken: pair.baseToken,
        quoteToken: pair.quoteToken,
        priceBasePerQuote,
        priceQuotePerBase,
        ts,
        blockNumber: Number(log.blockNumber),
      });
    }

    config.db.setCursor(pair.pairId, Number(to));
    if (logs.length > 0) {
      logger.info(
        `[price-indexer] ${pair.pairId}: scanned ${from}..${to} (+${logs.length} swaps)`,
      );
    }
  }

  async function tick(): Promise<void> {
    for (const pair of config.pairs) {
      try {
        await tickOne(pair);
      } catch (err) {
        logger.error(
          `[price-indexer] ${pair.pairId}: tick failed: ${(err as Error).message}`,
        );
      }
    }
  }

  async function start(): Promise<void> {
    while (!stopped) {
      await tick();
      if (stopped) break;
      await new Promise<void>((resolve) => {
        waiter = { resolve };
        waitTimer = setTimeout(() => {
          waitTimer = null;
          waiter = null;
          resolve();
        }, config.pollIntervalMs);
      });
    }
  }

  function stop(): void {
    stopped = true;
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
    if (waiter) {
      waiter.resolve();
      waiter = null;
    }
  }

  return { tick, start, stop };
}

/** Human-readable price for UI / logs. */
export function formatPrice18(price18: string): string {
  return formatUnits(BigInt(price18), 18);
}
