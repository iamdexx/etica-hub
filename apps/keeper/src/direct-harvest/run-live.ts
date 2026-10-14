import { loadDirectHarvestConfig } from './config.js';
import { runDirectHarvest } from './run.js';

const config = loadDirectHarvestConfig();
if (!config.dryRun && !config.privateKey) {
  console.error('[direct-harvest:live] HARVEST_PRIVATE_KEY unset; refusing to run');
  process.exit(1);
}
const result = await runDirectHarvest(config);
if (result.error) {
  console.error(`[direct-harvest:live] ${result.error}`);
  process.exit(1);
}
