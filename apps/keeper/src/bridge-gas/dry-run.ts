/**
 * Dry-run entry point: snapshots both legs, prints the decisions, submits
 * nothing. Safe to run with or without a key.
 */

import { loadBridgeGasConfig } from './config.js';
import { runBridgeGas } from './run.js';

const config = { ...loadBridgeGasConfig(), dryRun: true };
runBridgeGas(config)
  .then((r) => {
    console.info(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    if (r.error) process.exit(1);
  })
  .catch((err) => {
    console.error('[bridge-gas:dry-run] fatal:', err);
    process.exit(1);
  });
