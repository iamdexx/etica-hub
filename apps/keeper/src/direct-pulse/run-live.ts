import { loadDirectPulseConfig } from './config.js';
import { runDirectPulse } from './run.js';

const config = loadDirectPulseConfig();
if (!config.dryRun && !config.privateKey) {
  console.error('[direct-pulse:live] HARVEST_PRIVATE_KEY unset; refusing to run');
  process.exit(1);
}
const result = await runDirectPulse(config);
console.info(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
if (result.error) {
  console.error(`[direct-pulse:live] ${result.error}`);
  process.exit(1);
}
