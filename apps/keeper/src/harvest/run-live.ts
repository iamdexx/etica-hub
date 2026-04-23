/**
 * One-shot live entry point for GitHub Actions (manual dispatch only).
 *
 * Unlike `dry-run.ts`, this script does NOT force `dryRun=true`. It runs
 * `runHarvest()` with whatever the environment specifies — and deliberately
 * rejects the run when:
 *
 *   - `HARVEST_PRIVATE_KEY` is unset (can't sign),
 *   - `HARVEST_DRY_RUN` is explicitly truthy (caller meant to stay dry),
 *   - `HARVEST_HARVESTER_ADDRESS` is unset (live execution MUST go through
 *     the TreasuryHarvester delegation contract; the legacy treasury-signed
 *     multi-tx path is disabled in automation).
 *
 * `harvester.harvest` is permissionless on-chain, so the live workflow can
 * be signed by any funded EOA — the default cron uses a hot "crank" EOA
 * dedicated to this job, but any community member could equivalently run
 * this script from their own box if the default cron is down. The treasury
 * key is only used once, to pre-approve LP + ETX allowances to the
 * harvester contract.
 */

import { loadHarvestConfig } from './config.js';
import { runHarvest } from './run.js';

export async function runHarvestLive(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{
  submitted: number;
  skipped: boolean;
  error?: string;
}> {
  const config = loadHarvestConfig(env);

  if (config.dryRun) {
    log.error(
      '[harvest:live] refusing to run: HARVEST_DRY_RUN is truthy. ' +
        'Unset it (or set it to "false") to submit real transactions.',
    );
    return { submitted: 0, skipped: true, error: 'dry-run flag set' };
  }

  if (!config.privateKey) {
    log.error(
      '[harvest:live] refusing to run: HARVEST_PRIVATE_KEY is unset. ' +
        'Wire the hot keeper EOA key as a secret on the live workflow.',
    );
    return { submitted: 0, skipped: true, error: 'HARVEST_PRIVATE_KEY unset' };
  }

  if (!config.harvester) {
    log.error(
      '[harvest:live] refusing to run: HARVEST_HARVESTER_ADDRESS is unset. ' +
        'Live execution must go through the TreasuryHarvester delegation ' +
        'contract — running the legacy treasury-signed multi-tx flow from ' +
        'CI would require the treasury key.',
    );
    return { submitted: 0, skipped: true, error: 'HARVEST_HARVESTER_ADDRESS unset' };
  }

  const result = await runHarvest(config, { log });
  if (result.error) {
    log.error(`[harvest:live] error: ${result.error}`);
    return {
      submitted: result.submittedTxHashes.length,
      skipped: result.skipped,
      error: result.error,
    };
  }

  log.info(
    `[harvest:live] ${result.mode} run complete — ` +
      `submitted=${result.submittedTxHashes.length} skipped=${result.skipped}`,
  );
  return {
    submitted: result.submittedTxHashes.length,
    skipped: result.skipped,
  };
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/harvest/run-live.ts') ||
    process.argv[1].endsWith('/keeper/dist/harvest/run-live.js'));

if (invokedAsScript) {
  runHarvestLive()
    .then((r) => {
      if (r.error) process.exit(1);
    })
    .catch((err) => {
      console.error('[harvest:live] fatal:', err);
      process.exit(1);
    });
}
