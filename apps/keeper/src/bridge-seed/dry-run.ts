/** Snapshot + plan only; never submits. */

import { loadBridgeSeedConfig } from './config.js';
import { runBridgeSeed } from './run.js';

const config = loadBridgeSeedConfig({ ...process.env, BRIDGE_SEED_DRY_RUN: 'true' });
runBridgeSeed(config, { log: console })
  .then((r) => {
    console.info(JSON.stringify(r, null, 2));
    if (r.error) process.exit(1);
  })
  .catch((err) => {
    console.error('[bridge-seed:dry-run] fatal:', err);
    process.exit(1);
  });
