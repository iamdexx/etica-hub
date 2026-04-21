/**
 * One-shot dry-run entry point for GitHub Actions cron.
 *
 * Runs a single `tick()` and exits, regardless of whether orders were
 * found or not. If the registry isn't deployed yet (KEEPER_REGISTRY_ADDRESS
 * unset/zero) AND no ORDERBOOK_URL is set, exits cleanly with a skipped
 * message — the scheduled workflow should be a no-op, not a failure.
 *
 * Never submits transactions. KEEPER_DRY_RUN defaults to `true` when no
 * private key is set.
 */

import { isAddress } from 'viem';
import { loadConfig } from './config.js';
import { createKeeper } from './index.js';

export async function runDryRun(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{ skipped: boolean; fetched: number; fillable: number }> {
  const registryRaw = env.KEEPER_REGISTRY_ADDRESS;
  const orderbookRaw = env.ORDERBOOK_URL;
  const registrySet =
    typeof registryRaw === 'string' &&
    isAddress(registryRaw) &&
    registryRaw.toLowerCase() !== '0x0000000000000000000000000000000000000000';
  const orderbookSet = typeof orderbookRaw === 'string' && orderbookRaw.length > 0;

  if (!registrySet && !orderbookSet) {
    log.info(
      '[keeper:dry] skipping — KEEPER_REGISTRY_ADDRESS unset/zero and ORDERBOOK_URL unset. ' +
        'The registry has not been deployed yet; this run is a no-op.',
    );
    return { skipped: true, fetched: 0, fillable: 0 };
  }

  const config = loadConfig(env);
  // Force dry-run on this entry point regardless of private-key presence —
  // the cron workflow must never submit txs even if someone later wires a
  // signer key into secrets for a different job.
  const keeper = createKeeper({ ...config, dryRun: true });
  const { fetched, fillable } = await keeper.tick();
  log.info(`[keeper:dry] done: fetched=${fetched} fillable=${fillable}`);
  return { skipped: false, fetched, fillable };
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/dry-run.ts') ||
    process.argv[1].endsWith('/keeper/dist/dry-run.js'));

if (invokedAsScript) {
  runDryRun().catch((err) => {
    console.error('[keeper:dry] fatal:', err);
    process.exit(1);
  });
}
