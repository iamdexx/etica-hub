import { loadDirectPulseConfig } from './config.js';
import { runDirectPulse } from './run.js';

const config = { ...loadDirectPulseConfig(), dryRun: true };
const result = await runDirectPulse(config);
console.info(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
