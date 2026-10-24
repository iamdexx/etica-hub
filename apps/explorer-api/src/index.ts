import pg from 'pg';
import { createPublicClient, defineChain, fallback, http } from 'viem';
import { buildApi } from './api.js';
import { ensureSchema } from './schema.js';
import { syncForever } from './sync.js';

const env = process.env;
const DEFAULT_RPCS = [
  'https://eticamainnet.eticaprotocol.org',
  'https://eticamainnet.eticascan.org',
];
const eticaMainnet = defineChain({
  id: 61803,
  name: 'Etica Mainnet',
  nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
  rpcUrls: { default: { http: DEFAULT_RPCS } },
});
const pool = new pg.Pool({
  host: env.PG_HOST ?? 'db',
  port: Number(env.PG_PORT ?? 5432),
  database: env.PG_DATABASE ?? 'eticaenginedb',
  user: env.PG_USER ?? 'etica',
  password: env.PG_PASSWORD,
  max: 8,
});
const rpcs = (
  env.ETICA_RPC_URLS ??
  env.ETICA_RPC_URL ??
  eticaMainnet.rpcUrls.default.http.join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const client = createPublicClient({
  chain: eticaMainnet,
  transport: fallback(
    rpcs.map((u) =>
      http(u, { timeout: 30_000, retryCount: 2, batch: { batchSize: 50, wait: 10 } }),
    ),
    { rank: false },
  ),
});
const log = (msg: string) => console.log(`${new Date().toISOString()} [explorer-api] ${msg}`);

await ensureSchema(pool);
const app = buildApi(pool);
await app.listen({ port: Number(env.API_PORT ?? 6634), host: '0.0.0.0' });
log(`api listening on ${env.API_PORT ?? 6634}; rpcs=${rpcs.join(',')}`);
if (env.SYNC_DISABLED !== '1') {
  void syncForever(pool, client, {
    startBlock: Number(env.START_BLOCK ?? 0),
    batch: Number(env.SYNC_BATCH ?? 100),
    confirmations: Number(env.CONFIRMATIONS ?? 6),
    log,
  });
}
