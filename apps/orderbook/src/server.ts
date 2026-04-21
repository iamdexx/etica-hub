import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OrderRepository } from './db/index.js';
import { healthRoutes } from './routes/health.js';
import { ordersRoutes } from './routes/orders.js';

export interface BuildServerOptions {
  repo: OrderRepository;
  /** Optional shared secret required on POST /orders/:hash/mark-filled. */
  keeperAuthToken?: string;
  /** Fastify logger flag. */
  logger?: boolean;
  /** CORS origin allow-list. Default: ["*"] for dev; set in prod via env. */
  corsOrigin?: string | string[];
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, {
    origin: opts.corsOrigin ?? true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await app.register(healthRoutes);
  await app.register(ordersRoutes, {
    repo: opts.repo,
    keeperAuthToken: opts.keeperAuthToken,
  });

  return app;
}
