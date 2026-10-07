/**
 * One-shot live entry point (GitHub Actions). Refuses to run without the
 * keeper key or with the dry-run flag set, same contract as bridge-gas.
 */

import { loadBridgeSeedConfig } from './config.js';
import { runBridgeSeed, type BridgeSeedResult } from './run.js';

export async function runBridgeSeedLive(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<BridgeSeedResult> {
  const config = loadBridgeSeedConfig(env);
  if (config.dryRun) {
    log.error('[bridge-seed:live] refusing to run: BRIDGE_SEED_DRY_RUN is truthy.');
    return { dryRun: true, status: 'error', txHashes: [], error: 'dry-run flag set' };
  }
  if (!config.privateKey) {
    log.error('[bridge-seed:live] refusing to run: no signer key. Wire HARVEST_KEEPER_PRIVATE_KEY into HARVEST_PRIVATE_KEY.');
    return { dryRun: false, status: 'error', txHashes: [], error: 'signer key unset' };
  }
  return runBridgeSeed(config, { log });
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/bridge-seed/run-live.ts') ||
    process.argv[1].endsWith('/keeper/dist/bridge-seed/run-live.js'));

if (invokedAsScript) {
  runBridgeSeedLive()
    .then((r) => {
      console.info(JSON.stringify(r, null, 2));
      if (r.error) process.exit(1);
    })
    .catch((err) => {
      console.error('[bridge-seed:live] fatal:', err);
      process.exit(1);
    });
}
