/**
 * One-shot dry-run entry point for GitHub Actions cron.
 *
 * Runs a single `runHarvest()` tick in dry-run mode and exits. If the
 * canonical ETX pools don't exist yet, the script exits 0 with a skipped
 * message — the scheduled workflow should be a no-op, not a failure.
 *
 * This entry point always forces `dryRun=true`, regardless of whether a
 * `HARVEST_PRIVATE_KEY` is set in the environment. Live runs go through
 * `run-live.ts` which must be invoked explicitly from a workflow with
 * secrets wired.
 */

import { loadHarvestConfig } from './config.js';
import { runHarvest } from './run.js';

export async function runHarvestDryRun(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{ skipped: boolean; actions: number }> {
  // Must exit 0 when required addresses aren't set yet so the scheduled
  // workflow doesn't fail loudly before the first deploy.
  try {
    const config = loadHarvestConfig(env);
    const forced = { ...config, dryRun: true };
    const result = await runHarvest(forced, { log });
    if (result.error) {
      log.error(`[harvest:dry] error: ${result.error}`);
      return { skipped: true, actions: 0 };
    }
    return {
      skipped: result.skipped,
      actions: result.plan.actions.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Missing env vars are the common "not wired yet" case. Log + exit
    // cleanly so the workflow stays green until the operator sets things up.
    if (/missing required env/.test(msg)) {
      log.info(`[harvest:dry] skipping — ${msg}`);
      return { skipped: true, actions: 0 };
    }
    throw err;
  }
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/harvest/dry-run.ts') ||
    process.argv[1].endsWith('/keeper/dist/harvest/dry-run.js'));

if (invokedAsScript) {
  runHarvestDryRun().catch((err) => {
    console.error('[harvest:dry] fatal:', err);
    process.exit(1);
  });
}
