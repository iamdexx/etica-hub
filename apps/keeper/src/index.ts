/**
 * Reference keeper — v1 skeleton.
 *
 * What it does today:
 *   1. Polls the order-book API for open orders.
 *   2. Filters them: right reactor, deadline not imminent, decay window started.
 *   3. Logs a "would attempt fill" line per order.
 *   4. Graceful shutdown on SIGINT / SIGTERM.
 *
 * What it explicitly does NOT do yet (future PR):
 *   - Simulate the fill on-chain to check profitability.
 *   - Submit reactor.execute(...) transactions.
 *   - Report landed fills via POST /orders/:hash/mark-filled.
 *
 * Design notes:
 *   - Keeper is stateless between polls. Loss = skipped fill, not lost funds.
 *   - Anyone can run one. Competition is good for users.
 *   - Never holds user funds or keys — only its own signer key for tx gas.
 */

import { loadConfig, type KeeperConfig } from './config.js';
import { createOrderbookClient, type OrderbookClient, type OrderbookOrder } from './orderbook-client.js';
import { filterFillable } from './filter.js';

export interface KeeperDeps {
  /** Injected for tests. Defaults to real HTTP client. */
  client?: OrderbookClient;
  /** Injected clock for tests. Defaults to Date.now(). */
  now?: () => number;
  /** Injected logger. Defaults to console. */
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface Keeper {
  /** Run a single poll+filter iteration. */
  tick(): Promise<{ fetched: number; fillable: number }>;
  /** Start the polling loop. Resolves when stop() is called. */
  start(): Promise<void>;
  /** Stop the polling loop. Idempotent. */
  stop(): void;
}

export function createKeeper(config: KeeperConfig, deps: KeeperDeps = {}): Keeper {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const client =
    deps.client ??
    createOrderbookClient({
      baseUrl: config.orderbookUrl,
      keeperAuthToken: config.keeperAuthToken,
    });

  let running = false;
  let stopped = false;
  let waiter: { resolve: () => void } | null = null;

  async function tick(): Promise<{ fetched: number; fillable: number }> {
    const orders = await client.listOrders({
      status: 'open',
      limit: config.pollBatchSize,
      minDeadline: now() + config.deadlineGraceSeconds,
    });

    const fillable = filterFillable(orders, {
      reactor: config.reactor,
      now: now(),
      deadlineGraceSeconds: config.deadlineGraceSeconds,
    });

    for (const o of fillable) {
      // v1 stub: emit a structured line. v2 will simulate + submit.
      log.info(
        `[keeper] would attempt fill orderHash=${o.orderHash} swapper=${o.swapper} ` +
          `input=${o.input.token} output=${o.output.token} deadline=${o.deadline}`,
      );
    }

    return { fetched: orders.length, fillable: fillable.length };
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    log.info(
      `[keeper] starting: orderbook=${config.orderbookUrl} reactor=${config.reactor} ` +
        `interval=${config.pollIntervalMs}ms`,
    );

    while (!stopped) {
      try {
        const { fetched, fillable } = await tick();
        if (fetched > 0) log.info(`[keeper] tick: fetched=${fetched} fillable=${fillable}`);
      } catch (err) {
        log.error(`[keeper] tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (stopped) break;

      await new Promise<void>((resolve) => {
        waiter = { resolve };
        const t = setTimeout(() => {
          waiter = null;
          resolve();
        }, config.pollIntervalMs);
        // Allow stop() to short-circuit the wait.
        if (stopped) {
          clearTimeout(t);
          waiter = null;
          resolve();
        }
      });
    }

    running = false;
    log.info('[keeper] stopped');
  }

  function stop(): void {
    stopped = true;
    if (waiter) {
      waiter.resolve();
      waiter = null;
    }
  }

  return { tick, start, stop };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const keeper = createKeeper(config);

  const shutdown = (sig: NodeJS.Signals) => {
    console.info(`[keeper] received ${sig}, shutting down`);
    keeper.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await keeper.start();
  process.exit(0);
}

// Only run main when executed directly, not when imported for tests.
const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/index.ts') ||
    process.argv[1].endsWith('/keeper/dist/index.js'));

if (invokedAsScript) {
  main().catch((err) => {
    console.error('[keeper] fatal:', err);
    process.exit(1);
  });
}
