import type { FastifyInstance } from 'fastify';
import { isAddress, keccak256, type Hex } from 'viem';
import { z } from 'zod';
import type { OrderRepository } from '../db/index.js';
import { decodeDutchOrder, validateOrderStructure } from '../eip712.js';
import type {
  OrderFilter,
  OrderStatus,
  StoredOrder,
  StrategyType,
  TriggerDirection,
} from '../types.js';

const HEX_RE = /^0x[0-9a-fA-F]+$/;

const DECIMAL_RE = /^[0-9]+$/;

const PostOrderBody = z
  .object({
    encodedOrder: z.string().regex(HEX_RE, 'encodedOrder must be 0x-prefixed hex'),
    signature: z.string().regex(HEX_RE, 'signature must be 0x-prefixed hex'),
    strategyType: z.enum(['limit', 'stop']).optional(),
    triggerPrice: z
      .string()
      .regex(DECIMAL_RE, 'triggerPrice must be a stringified bigint (no 0x prefix)')
      .optional(),
    triggerDirection: z.enum(['lte', 'gte']).optional(),
  })
  .superRefine((body, ctx) => {
    const isStop = body.strategyType === 'stop';
    if (isStop) {
      if (!body.triggerPrice) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['triggerPrice'],
          message: 'stop orders require triggerPrice',
        });
      }
      if (!body.triggerDirection) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['triggerDirection'],
          message: 'stop orders require triggerDirection',
        });
      }
    } else if (body.triggerPrice || body.triggerDirection) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategyType'],
        message: 'triggerPrice/triggerDirection only valid on stop orders',
      });
    }
  });

const CancelOrderBody = z.object({
  cancelTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'cancelTxHash must be a 32-byte hex tx hash'),
});

const MarkFilledBody = z.object({
  fillTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'fillTxHash must be a 32-byte hex tx hash'),
  fillBlockNumber: z.number().int().nonnegative(),
});

function ensureAddress(x: string, field: string): asserts x is `0x${string}` {
  if (!isAddress(x)) throw new Error(`${field} is not a valid address`);
}

function serializeOrder(o: StoredOrder) {
  return {
    orderHash: o.orderHash,
    reactor: o.reactor,
    swapper: o.swapper,
    nonce: o.nonce,
    deadline: o.deadline,
    decayStartTime: o.decayStartTime,
    decayEndTime: o.decayEndTime,
    input: {
      token: o.inputToken,
      startAmount: o.inputStartAmount,
      endAmount: o.inputEndAmount,
    },
    output: {
      token: o.outputToken,
      startAmount: o.outputStartAmount,
      endAmount: o.outputEndAmount,
      recipient: o.outputRecipient,
    },
    encodedOrder: o.encodedOrder,
    signature: o.signature,
    status: o.status,
    strategyType: o.strategyType,
    triggerPrice: o.triggerPrice,
    triggerDirection: o.triggerDirection,
    fillTxHash: o.fillTxHash,
    fillBlockNumber: o.fillBlockNumber,
    cancelTxHash: o.cancelTxHash,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

interface OrdersRouteOptions {
  repo: OrderRepository;
  /** Keeper auth token. POST /orders/:hash/mark-filled requires this header. */
  keeperAuthToken?: string;
}

export async function ordersRoutes(app: FastifyInstance, opts: OrdersRouteOptions): Promise<void> {
  const { repo, keeperAuthToken } = opts;

  // POST /orders — submit a signed order.
  app.post('/orders', async (req, reply) => {
    const parsed = PostOrderBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.errors });
    }

    const encodedOrder = parsed.data.encodedOrder as Hex;
    const signature = parsed.data.signature as Hex;
    const strategyType: StrategyType = parsed.data.strategyType ?? 'limit';
    const triggerPrice: string | null =
      strategyType === 'stop' ? (parsed.data.triggerPrice as string) : null;
    const triggerDirection: TriggerDirection | null =
      strategyType === 'stop' ? (parsed.data.triggerDirection as TriggerDirection) : null;

    let decoded;
    try {
      decoded = decodeDutchOrder(encodedOrder);
    } catch (err) {
      return reply.code(400).send({
        error: 'decode_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const structErr = validateOrderStructure(decoded, signature);
    if (structErr) return reply.code(400).send({ error: 'invalid_order', detail: structErr });

    // Storage key: keccak256 of the encoded order. Deterministic + unique per
    // order (different nonces -> different hashes). This is NOT identical to
    // UniswapX's on-chain EIP-712 order hash, which is computed over the
    // type-hashed struct fields and can be added later without breaking the
    // API (clients refer to orders by this key in GET + DELETE).
    const orderHash = keccak256(encodedOrder);

    if (repo.findByHash(orderHash) !== null) {
      return reply.code(409).send({ error: 'order_already_exists', orderHash });
    }

    const firstOutput = decoded.outputs[0];
    if (!firstOutput) return reply.code(400).send({ error: 'invalid_order', detail: 'no outputs' });

    const stored: StoredOrder = {
      orderHash,
      reactor: decoded.reactor,
      swapper: decoded.swapper,
      nonce: decoded.nonce.toString(),
      deadline: Number(decoded.deadline),
      decayStartTime: Number(decoded.decayStartTime),
      decayEndTime: Number(decoded.decayEndTime),
      inputToken: decoded.input.token,
      inputStartAmount: decoded.input.startAmount.toString(),
      inputEndAmount: decoded.input.endAmount.toString(),
      outputToken: firstOutput.token,
      outputStartAmount: firstOutput.startAmount.toString(),
      outputEndAmount: firstOutput.endAmount.toString(),
      outputRecipient: firstOutput.recipient,
      encodedOrder,
      signature,
      status: 'open',
      strategyType,
      triggerPrice,
      triggerDirection,
      fillTxHash: null,
      fillBlockNumber: null,
      cancelTxHash: null,
      createdAt: '', // sqlite default takes over
      updatedAt: '',
    };

    repo.insertOrder(stored);
    const saved = repo.findByHash(orderHash);
    return reply.code(201).send(saved ? serializeOrder(saved) : { orderHash });
  });

  // GET /orders — list with filters.
  app.get('/orders', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;

    const filter: OrderFilter = {};
    if (q.status && ['open', 'filled', 'cancelled', 'expired'].includes(q.status)) {
      filter.status = q.status as OrderStatus;
    }
    if (q.swapper && isAddress(q.swapper)) {
      filter.swapper = q.swapper as `0x${string}`;
    }
    if (q.inputToken && isAddress(q.inputToken)) {
      filter.inputToken = q.inputToken as `0x${string}`;
    }
    if (q.outputToken && isAddress(q.outputToken)) {
      filter.outputToken = q.outputToken as `0x${string}`;
    }
    if (q.strategyType && ['limit', 'stop'].includes(q.strategyType)) {
      filter.strategyType = q.strategyType as StrategyType;
    }
    if (q.minDeadline) {
      const n = Number(q.minDeadline);
      if (Number.isFinite(n)) filter.minDeadline = n;
    }
    if (q.limit) {
      const n = Number(q.limit);
      if (Number.isFinite(n) && n > 0) filter.limit = n;
    }
    if (q.offset) {
      const n = Number(q.offset);
      if (Number.isFinite(n) && n >= 0) filter.offset = n;
    }

    const orders = repo.listOrders(filter);
    return reply.send({ orders: orders.map(serializeOrder), count: orders.length });
  });

  // GET /orders/:hash — single order.
  app.get('/orders/:hash', async (req, reply) => {
    const params = req.params as { hash?: string };
    const hash = params.hash ?? '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return reply.code(400).send({ error: 'invalid_hash' });
    }
    const order = repo.findByHash(hash);
    if (!order) return reply.code(404).send({ error: 'not_found' });
    return reply.send(serializeOrder(order));
  });

  // POST /orders/:hash/cancel — record a user-initiated on-chain cancellation.
  //
  // The actual Permit2 nonce invalidation happens on-chain when the user calls
  // `permit2.invalidateUnorderedNonces(...)` or fires a cancel tx against the
  // reactor. This endpoint just records the tx hash so the keeper stops
  // attempting fills and the UI can surface "cancelled" to the user.
  app.post('/orders/:hash/cancel', async (req, reply) => {
    const params = req.params as { hash?: string };
    const hash = params.hash ?? '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return reply.code(400).send({ error: 'invalid_hash' });
    }

    const parsed = CancelOrderBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.errors });
    }

    const existing = repo.findByHash(hash);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (existing.status !== 'open') {
      return reply.code(409).send({ error: 'not_cancelable', status: existing.status });
    }

    repo.updateStatus(hash, 'cancelled', { cancelTxHash: parsed.data.cancelTxHash });
    const updated = repo.findByHash(hash);
    return reply.send(updated ? serializeOrder(updated) : { ok: true });
  });

  // POST /orders/:hash/mark-filled — keeper reports a landed fill tx.
  //
  // Auth: requires `X-Keeper-Auth: <KEEPER_AUTH_TOKEN>` header if the env var
  // was set at startup. In dev without a token the endpoint is open so the
  // reference keeper can be pointed at any orderbook instance.
  app.post('/orders/:hash/mark-filled', async (req, reply) => {
    if (keeperAuthToken) {
      const provided = req.headers['x-keeper-auth'];
      if (provided !== keeperAuthToken) return reply.code(401).send({ error: 'unauthorized' });
    }

    const params = req.params as { hash?: string };
    const hash = params.hash ?? '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return reply.code(400).send({ error: 'invalid_hash' });
    }

    const parsed = MarkFilledBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.errors });
    }

    const existing = repo.findByHash(hash);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (existing.status !== 'open') {
      return reply.code(409).send({ error: 'not_fillable', status: existing.status });
    }

    repo.updateStatus(hash, 'filled', {
      fillTxHash: parsed.data.fillTxHash,
      fillBlockNumber: parsed.data.fillBlockNumber,
    });
    const updated = repo.findByHash(hash);
    return reply.send(updated ? serializeOrder(updated) : { ok: true });
  });
}

export { ensureAddress };
