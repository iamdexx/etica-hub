import type { FastifyInstance } from 'fastify';
import { isAddress, keccak256, verifyMessage, type Hex } from 'viem';
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

const DCA_BATCH_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

const GRID_BATCH_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

const PostOrderBody = z
  .object({
    encodedOrder: z.string().regex(HEX_RE, 'encodedOrder must be 0x-prefixed hex'),
    signature: z.string().regex(HEX_RE, 'signature must be 0x-prefixed hex'),
    strategyType: z.enum(['limit', 'stop', 'dca', 'grid']).optional(),
    triggerPrice: z
      .string()
      .regex(DECIMAL_RE, 'triggerPrice must be a stringified bigint (no 0x prefix)')
      .optional(),
    triggerDirection: z.enum(['lte', 'gte']).optional(),
    dcaBatchId: z
      .string()
      .regex(DCA_BATCH_ID_RE, 'dcaBatchId must be 8-64 hex/dash characters')
      .optional(),
    dcaIndex: z.number().int().nonnegative().optional(),
    dcaTotal: z.number().int().positive().optional(),
    gridBatchId: z
      .string()
      .regex(GRID_BATCH_ID_RE, 'gridBatchId must be 8-64 hex/dash characters')
      .optional(),
    gridIndex: z.number().int().nonnegative().optional(),
    gridTotal: z.number().int().positive().optional(),
    gridLevelPrice: z
      .string()
      .regex(DECIMAL_RE, 'gridLevelPrice must be a stringified bigint (no 0x prefix)')
      .optional(),
  })
  .superRefine((body, ctx) => {
    const isStop = body.strategyType === 'stop';
    const isDca = body.strategyType === 'dca';
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

    if (isDca) {
      if (!body.dcaBatchId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dcaBatchId'],
          message: 'dca orders require dcaBatchId',
        });
      }
      if (body.dcaIndex === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dcaIndex'],
          message: 'dca orders require dcaIndex',
        });
      }
      if (body.dcaTotal === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dcaTotal'],
          message: 'dca orders require dcaTotal',
        });
      }
      if (
        body.dcaIndex !== undefined &&
        body.dcaTotal !== undefined &&
        body.dcaIndex >= body.dcaTotal
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dcaIndex'],
          message: 'dcaIndex must be < dcaTotal',
        });
      }
    } else if (
      body.dcaBatchId !== undefined ||
      body.dcaIndex !== undefined ||
      body.dcaTotal !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategyType'],
        message: 'dcaBatchId/dcaIndex/dcaTotal only valid on dca orders',
      });
    }

    const isGrid = body.strategyType === 'grid';
    if (isGrid) {
      if (!body.gridBatchId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gridBatchId'],
          message: 'grid orders require gridBatchId',
        });
      }
      if (body.gridIndex === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gridIndex'],
          message: 'grid orders require gridIndex',
        });
      }
      if (body.gridTotal === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gridTotal'],
          message: 'grid orders require gridTotal',
        });
      }
      if (!body.gridLevelPrice) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gridLevelPrice'],
          message: 'grid orders require gridLevelPrice',
        });
      }
      if (
        body.gridIndex !== undefined &&
        body.gridTotal !== undefined &&
        body.gridIndex >= body.gridTotal
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gridIndex'],
          message: 'gridIndex must be < gridTotal',
        });
      }
    } else if (
      body.gridBatchId !== undefined ||
      body.gridIndex !== undefined ||
      body.gridTotal !== undefined ||
      body.gridLevelPrice !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategyType'],
        message: 'gridBatchId/gridIndex/gridTotal/gridLevelPrice only valid on grid orders',
      });
    }
  });

const CancelOrderBody = z.object({
  cancelTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'cancelTxHash must be a 32-byte hex tx hash'),
  /** EIP-191 personal_sign signature from the order's swapper over
   * `buildCancelAuthMessage(orderHash, cancelTxHash)`. Proves the caller
   * controls the swapper key, not just that they know the public orderHash
   * (which is observable in OrderPosted events / GET /orders). Without this
   * any observer could mark any open order cancelled and DoS the keeper. */
  cancelSignature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'cancelSignature must be 0x-prefixed hex'),
});

/**
 * Canonical EIP-191 personal_sign message the swapper must sign to authorize
 * an orderbook-level cancel. Exported so the web client can produce matching
 * bytes and tests can assert the shape.
 */
export function buildCancelAuthMessage(orderHash: string, cancelTxHash: string): string {
  return [
    'EticaHub orderbook cancel',
    `orderHash: ${orderHash.toLowerCase()}`,
    `cancelTxHash: ${cancelTxHash.toLowerCase()}`,
  ].join('\n');
}

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
    dcaBatchId: o.dcaBatchId,
    dcaIndex: o.dcaIndex,
    dcaTotal: o.dcaTotal,
    gridBatchId: o.gridBatchId,
    gridIndex: o.gridIndex,
    gridTotal: o.gridTotal,
    gridLevelPrice: o.gridLevelPrice,
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
    const dcaBatchId: string | null =
      strategyType === 'dca' ? (parsed.data.dcaBatchId as string) : null;
    const dcaIndex: number | null =
      strategyType === 'dca' ? (parsed.data.dcaIndex as number) : null;
    const dcaTotal: number | null =
      strategyType === 'dca' ? (parsed.data.dcaTotal as number) : null;
    const gridBatchId: string | null =
      strategyType === 'grid' ? (parsed.data.gridBatchId as string) : null;
    const gridIndex: number | null =
      strategyType === 'grid' ? (parsed.data.gridIndex as number) : null;
    const gridTotal: number | null =
      strategyType === 'grid' ? (parsed.data.gridTotal as number) : null;
    const gridLevelPrice: string | null =
      strategyType === 'grid' ? (parsed.data.gridLevelPrice as string) : null;

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
      dcaBatchId,
      dcaIndex,
      dcaTotal,
      gridBatchId,
      gridIndex,
      gridTotal,
      gridLevelPrice,
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
    if (q.strategyType && ['limit', 'stop', 'dca', 'grid'].includes(q.strategyType)) {
      filter.strategyType = q.strategyType as StrategyType;
    }
    if (q.dcaBatchId && DCA_BATCH_ID_RE.test(q.dcaBatchId)) {
      filter.dcaBatchId = q.dcaBatchId;
    }
    if (q.gridBatchId && GRID_BATCH_ID_RE.test(q.gridBatchId)) {
      filter.gridBatchId = q.gridBatchId;
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
  //
  // Auth: body must include `cancelSignature`, an EIP-191 personal_sign
  // signature from the order's swapper over `buildCancelAuthMessage(...)`.
  // Without this any observer could mark any open order cancelled and DoS
  // the keeper.
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

    const message = buildCancelAuthMessage(hash, parsed.data.cancelTxHash);
    let authorized = false;
    try {
      authorized = await verifyMessage({
        address: existing.swapper as `0x${string}`,
        message,
        signature: parsed.data.cancelSignature as Hex,
      });
    } catch {
      authorized = false;
    }
    if (!authorized) return reply.code(401).send({ error: 'unauthorized' });

    repo.updateStatus(hash, 'cancelled', { cancelTxHash: parsed.data.cancelTxHash });
    const updated = repo.findByHash(hash);
    return reply.send(updated ? serializeOrder(updated) : { ok: true });
  });

  // POST /orders/:hash/mark-filled — keeper reports a landed fill tx.
  //
  // Auth: requires `X-Keeper-Auth: <KEEPER_AUTH_TOKEN>` header. Fails closed
  // if the env var is unset at startup (503) so a misconfigured deployment
  // can't silently accept anonymous fill claims.
  app.post('/orders/:hash/mark-filled', async (req, reply) => {
    if (!keeperAuthToken) {
      return reply.code(503).send({ error: 'keeper_auth_not_configured' });
    }
    const provided = req.headers['x-keeper-auth'];
    if (provided !== keeperAuthToken) return reply.code(401).send({ error: 'unauthorized' });

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
