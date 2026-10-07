/**
 * One-shot live entry point (GitHub Actions). Refuses to run without the
 * keeper key or with the dry-run flag set, same contract as the forfeit
 * sweep.
 */

import { loadBridgeGasConfig } from './config.js';
import { runBridgeGas, type BridgeGasRunResult } from './run.js';

export async function runBridgeGasLive(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<BridgeGasRunResult> {
  const config = loadBridgeGasConfig(env);
  if (config.dryRun) {
    log.error('[bridge-gas:live] refusing to run: BRIDGE_GAS_DRY_RUN is truthy.');
    return { dryRun: true, legs: [], error: 'dry-run flag set' };
  }
  if (!config.privateKey) {
    log.error(
      '[bridge-gas:live] refusing to run: no signer key. Wire HARVEST_KEEPER_PRIVATE_KEY into HARVEST_PRIVATE_KEY.',
    );
    return { dryRun: false, legs: [], error: 'signer key unset' };
  }
  return runBridgeGas(config, { log });
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/bridge-gas/run-live.ts') ||
    process.argv[1].endsWith('/keeper/dist/bridge-gas/run-live.js'));

if (invokedAsScript) {
  runBridgeGasLive()
    .then((r) => {
      if (r.error) process.exit(1);
    })
    .catch((err) => {
      console.error('[bridge-gas:live] fatal:', err);
      process.exit(1);
    });
}
