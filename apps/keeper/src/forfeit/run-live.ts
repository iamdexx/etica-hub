/**
 * One-shot live entry point for the forfeit sweep (GitHub Actions).
 *
 * Refuses to run without a signer, and refuses to pretend a dry-run
 * configuration is a live one. The signer is the same unprivileged
 * gas-paying EOA the farm harvest uses: a matured claim mints to the
 * treasury whatever wallet submits it, so the key can never take custody
 * of a discovery.
 */

import { loadForfeitConfig } from './config.js';
import { runForfeitSweep, type ForfeitRunResult } from './run.js';

export async function runForfeitLive(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<ForfeitRunResult> {
  const config = loadForfeitConfig(env);

  if (config.dryRun) {
    log.error(
      '[forfeit:live] refusing to run: FORFEIT_DRY_RUN is truthy. ' +
        'Unset it (or set it to "false") to submit real transactions.',
    );
    return { dryRun: true, fetched: 0, settled: 0, results: [], error: 'dry-run flag set' };
  }

  if (!config.privateKey) {
    log.error(
      '[forfeit:live] refusing to run: no signer key. Wire the harvest ' +
        'keeper EOA key (HARVEST_KEEPER_PRIVATE_KEY) into HARVEST_PRIVATE_KEY.',
    );
    return { dryRun: false, fetched: 0, settled: 0, results: [], error: 'signer key unset' };
  }

  return runForfeitSweep(config, { log });
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/forfeit/run-live.ts') ||
    process.argv[1].endsWith('/keeper/dist/forfeit/run-live.js'));

if (invokedAsScript) {
  runForfeitLive()
    .then((r) => {
      if (r.error) process.exit(1);
    })
    .catch((err) => {
      console.error('[forfeit:live] fatal:', err);
      process.exit(1);
    });
}
