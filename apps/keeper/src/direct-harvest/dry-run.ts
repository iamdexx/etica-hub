import { loadDirectHarvestConfig } from './config.js';
import { runDirectHarvest } from './run.js';

const config = { ...loadDirectHarvestConfig(), dryRun: true };
const result = await runDirectHarvest(config);
console.info(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
