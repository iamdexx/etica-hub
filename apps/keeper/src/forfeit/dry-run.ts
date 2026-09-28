/**
 * Dry-run entry point: fetches attestations and simulates every claim
 * (so a payload that would revert is reported) without submitting.
 */

import { loadForfeitConfig } from './config.js';
import { runForfeitSweep } from './run.js';

const config = { ...loadForfeitConfig(), dryRun: true };

runForfeitSweep(config)
  .then((result) => {
    for (const r of result.results) {
      console.info(`  ${r.status.padEnd(15)} ${r.branchGoalId} ${r.reason ?? r.tokenId ?? ''}`);
    }
  })
  .catch((err) => {
    console.error('[forfeit:dry-run] fatal:', err);
    process.exit(1);
  });
