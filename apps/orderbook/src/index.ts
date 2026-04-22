import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createSqliteRepository } from './db/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const host = process.env.ORDERBOOK_HOST ?? '0.0.0.0';
  const port = Number(process.env.ORDERBOOK_PORT ?? 3100);
  const dbPath = resolve(process.env.ORDERBOOK_DB_PATH ?? './orderbook.db');
  const keeperAuthToken = process.env.KEEPER_AUTH_TOKEN;
  const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim());

  mkdirSync(dirname(dbPath), { recursive: true });
  const repo = createSqliteRepository(dbPath);
  const app = await buildServer({
    repo,
    keeperAuthToken,
    corsOrigin,
    logger: true,
  });

  app.log.info(
    JSON.stringify({
      event: 'orderbook.boot',
      host,
      port,
      dbPath,
      keeperAuth: Boolean(keeperAuthToken),
    }),
  );

  if (!keeperAuthToken) {
    app.log.warn(
      JSON.stringify({
        event: 'orderbook.boot.warning',
        message:
          'KEEPER_AUTH_TOKEN is not set. POST /orders/:hash/mark-filled will reject all requests with 503.',
      }),
    );
  }

  await app.listen({ host, port });

  const shutdown = async (signal: string) => {
    app.log.info({ event: 'orderbook.shutdown', signal });
    await app.close();
    repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
