import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { PriceDb } from './db';

export interface PriceServerOptions {
  db: PriceDb;
  pairIds: string[];
  logger?: boolean;
  /** CORS origins — defaults to "*" so the site can read freely. */
  corsOrigin?: string | string[];
}

const INTERVALS: Record<string, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
};

export async function buildPriceServer(opts: PriceServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: opts.corsOrigin ?? '*' });

  const knownPairs = new Set(opts.pairIds);

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/prices/pairs', async () => ({ pairs: opts.pairIds }));

  app.get<{ Params: { pairId: string } }>('/prices/:pairId/latest', async (req, reply) => {
    const pairId = req.params.pairId;
    if (!knownPairs.has(pairId)) {
      return reply.code(404).send({ error: 'unknown pairId' });
    }
    const row = opts.db.getLatestPrice(pairId);
    if (!row) {
      return reply.code(404).send({ error: 'no price yet' });
    }
    return row;
  });

  app.get<{
    Params: { pairId: string };
    Querystring: { interval?: string; limit?: string };
  }>('/prices/:pairId/candles', async (req, reply) => {
    const pairId = req.params.pairId;
    if (!knownPairs.has(pairId)) {
      return reply.code(404).send({ error: 'unknown pairId' });
    }
    const intervalKey = (req.query.interval ?? '1m').toLowerCase();
    const intervalSeconds = INTERVALS[intervalKey];
    if (!intervalSeconds) {
      return reply.code(400).send({
        error: `invalid interval; must be one of ${Object.keys(INTERVALS).join(', ')}`,
      });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '240', 10) || 240, 1), 2000);
    const candles = opts.db.getCandles(pairId, intervalSeconds, limit);
    return { pairId, interval: intervalKey, candles };
  });

  return app;
}
