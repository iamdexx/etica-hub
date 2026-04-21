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
import {
  createKeeperPublicClient,
  fetchRegistryOrders,
} from './registry-source.js';
import type { PublicClient } from 'viem';

/**
 * Abstract source of open orders — either the off-chain HTTP orderbook or
 * an on-chain `OrderRegistry`. Both produce `OrderbookOrder[]`.
 */
export interface OrderSource {
  listOpen(limit: number, minDeadline: number): Promise<OrderbookOrder[]>;
  /** Surface name for startup logs. */
  description: string;
}

export interface KeeperDeps {
  /** Injected for tests. Defaults to a source derived from config. */
  source?: OrderSource;
  /** Injected for tests. Defaults to real HTTP client. */
  client?: OrderbookClient;
  /** Injected clock for tests. Defaults to Date.now(). */
  now?: () => number;
  /** Injected logger. Defaults to console. */
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

function buildDefaultSource(config: KeeperConfig, client?: OrderbookClient): OrderSource {
  if (config.registryAddress) {
    const publicClient: PublicClient = createKeeperPublicClient(config.rpcUrl);
    return {
      description: `registry ${config.registryAddress} via ${config.rpcUrl}`,
      async listOpen(limit, minDeadline) {
        const orders = await fetchRegistryOrders({
          publicClient,
          registry: config.registryAddress!,
        });
        // The registry source doesn't apply deadline / limit server-side,
        // so replicate the orderbook's semantics here.
        const kept = orders.filter((o) => o.deadline > minDeadline);
        return kept.slice(0, limit);
      },
    };
  }
  if (!config.orderbookUrl) {
    throw new Error('no source configured — should have been rejected by loadConfig');
  }
  const httpClient =
    client ??
    createOrderbookClient({
      baseUrl: config.orderbookUrl,
      keeperAuthToken: config.keeperAuthToken,
    });
  return {
    description: `orderbook ${config.orderbookUrl}`,
    async listOpen(limit, minDeadline) {
      return httpClient.listOrders({ status: 'open', limit, minDeadline });
    },
  };
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

  const source = deps.source ?? buildDefaultSource(config, deps.client);

  let running = false;
  let stopped = false;
  let waiter: { resolve: () => void } | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<{ fetched: number; fillable: number }> {
    const orders = await source.listOpen(
      config.pollBatchSize,
      now() + config.deadlineGraceSeconds,
    );

    const fillable = filterFillable(orders, {
      reactor: config.reactor,
      now: now(),
      deadlineGraceSeconds: config.deadlineGraceSeconds,
    });

    for (const o of fillable) {
      // v1 stub: emit a structured line. v2 will simulate + submit.
      const prefix = config.dryRun ? '[keeper:dry] would attempt fill' : '[keeper] would attempt fill';
      log.info(
        `${prefix} orderHash=${o.orderHash} swapper=${o.swapper} ` +
          `input=${o.input.token} output=${o.output.token} deadline=${o.deadline}`,
      );
    }

    return { fetched: orders.length, fillable: fillable.length };
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    log.info(
      `[keeper] starting: source=${source.description} reactor=${config.reactor} ` +
        `interval=${config.pollIntervalMs}ms dryRun=${config.dryRun}`,
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
        waitTimer = setTimeout(() => {
          waitTimer = null;
          waiter = null;
          resolve();
        }, config.pollIntervalMs);
        // Allow stop() to short-circuit the wait.
        if (stopped) {
          if (waitTimer) clearTimeout(waitTimer);
          waitTimer = null;
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
