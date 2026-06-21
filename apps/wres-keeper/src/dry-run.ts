/**
 * One-shot dry run.
 *
 * Forces DRY-RUN regardless of env, runs exactly one tick, prints the report,
 * and exits. This is the safe way to validate config + RPC reachability + the
 * full decision loop against live (test)net contracts without broadcasting a
 * single transaction. Wired as `pnpm --filter @etica-hub/wres-keeper dry-run`.
 */

import { loadConfig } from './config.js';
import { createKeeper, runTick } from './keeper.js';

async function main(): Promise<void> {
  const config = { ...loadConfig(), dryRun: true };
  const log = console;
  const keeper = createKeeper(config, log);

  log.info('[dry-run] single tick, DRY-RUN forced — no transactions will be broadcast');
  const report = await runTick(keeper);
  log.info(
    `[dry-run] done: would-mint=${report.minted} would-pay=${report.paid} ` +
      `skipped=${report.skipped}`,
  );
}

main().catch((err) => {
  console.error('[dry-run] fatal:', err);
  process.exitCode = 1;
});
