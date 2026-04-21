import Database from 'better-sqlite3';
import type { OrderFilter, OrderStatus, StoredOrder, StrategyType, TriggerDirection } from '../types.js';

/**
 * Minimal SQLite-backed order store.
 *
 * Postgres support (for prod) ships in a follow-up PR; the repository interface
 * is deliberately narrow so we can swap out the driver without touching routes.
 */

export interface OrderRepository {
  insertOrder(order: StoredOrder): void;
  findByHash(orderHash: string): StoredOrder | null;
  listOrders(filter: OrderFilter): StoredOrder[];
  updateStatus(
    orderHash: string,
    status: OrderStatus,
    extra?: { fillTxHash?: string; fillBlockNumber?: number; cancelTxHash?: string },
  ): boolean;
  close(): void;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS orders (
  order_hash           TEXT PRIMARY KEY,
  reactor              TEXT NOT NULL,
  swapper              TEXT NOT NULL,
  nonce                TEXT NOT NULL,
  deadline             INTEGER NOT NULL,
  decay_start_time     INTEGER NOT NULL,
  decay_end_time       INTEGER NOT NULL,
  input_token          TEXT NOT NULL,
  input_start_amount   TEXT NOT NULL,
  input_end_amount     TEXT NOT NULL,
  output_token         TEXT NOT NULL,
  output_start_amount  TEXT NOT NULL,
  output_end_amount    TEXT NOT NULL,
  output_recipient     TEXT NOT NULL,
  encoded_order        TEXT NOT NULL,
  signature            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  strategy_type        TEXT NOT NULL DEFAULT 'limit',
  trigger_price        TEXT,
  trigger_direction    TEXT,
  fill_tx_hash         TEXT,
  fill_block_number    INTEGER,
  cancel_tx_hash       TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status_deadline ON orders (status, deadline);
CREATE INDEX IF NOT EXISTS idx_orders_swapper         ON orders (swapper);
CREATE INDEX IF NOT EXISTS idx_orders_input_token     ON orders (input_token);
CREATE INDEX IF NOT EXISTS idx_orders_output_token    ON orders (output_token);
`;

// Indexes that reference columns added by `migrateSchema` must be created
// *after* the migration runs — otherwise startup crashes on pre-existing DBs
// whose base table pre-dates the column.
const CREATE_MIGRATED_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_orders_strategy_type   ON orders (strategy_type);
`;

/**
 * Add columns that landed in later migrations to pre-existing SQLite files.
 * Each `ALTER TABLE ... ADD COLUMN` is wrapped in a try so repeat runs on
 * already-migrated schemas are no-ops (SQLite throws on duplicate columns).
 */
function migrateSchema(db: Database.Database): void {
  const addColumn = (name: string, typeClause: string): void => {
    try {
      db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${typeClause}`);
    } catch {
      // column already exists — no-op.
    }
  };
  addColumn('strategy_type', "TEXT NOT NULL DEFAULT 'limit'");
  addColumn('trigger_price', 'TEXT');
  addColumn('trigger_direction', 'TEXT');
}

interface OrderRow {
  order_hash: string;
  reactor: string;
  swapper: string;
  nonce: string;
  deadline: number;
  decay_start_time: number;
  decay_end_time: number;
  input_token: string;
  input_start_amount: string;
  input_end_amount: string;
  output_token: string;
  output_start_amount: string;
  output_end_amount: string;
  output_recipient: string;
  encoded_order: string;
  signature: string;
  status: string;
  strategy_type: string;
  trigger_price: string | null;
  trigger_direction: string | null;
  fill_tx_hash: string | null;
  fill_block_number: number | null;
  cancel_tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

function rowToOrder(row: OrderRow): StoredOrder {
  return {
    orderHash: row.order_hash as `0x${string}`,
    reactor: row.reactor as `0x${string}`,
    swapper: row.swapper as `0x${string}`,
    nonce: row.nonce,
    deadline: row.deadline,
    decayStartTime: row.decay_start_time,
    decayEndTime: row.decay_end_time,
    inputToken: row.input_token as `0x${string}`,
    inputStartAmount: row.input_start_amount,
    inputEndAmount: row.input_end_amount,
    outputToken: row.output_token as `0x${string}`,
    outputStartAmount: row.output_start_amount,
    outputEndAmount: row.output_end_amount,
    outputRecipient: row.output_recipient as `0x${string}`,
    encodedOrder: row.encoded_order as `0x${string}`,
    signature: row.signature as `0x${string}`,
    status: row.status as OrderStatus,
    strategyType: (row.strategy_type as StrategyType) ?? 'limit',
    triggerPrice: row.trigger_price ?? null,
    triggerDirection: (row.trigger_direction as TriggerDirection | null) ?? null,
    fillTxHash: (row.fill_tx_hash as `0x${string}` | null) ?? null,
    fillBlockNumber: row.fill_block_number,
    cancelTxHash: (row.cancel_tx_hash as `0x${string}` | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteRepository(dbPath: string): OrderRepository {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE_SQL);
  migrateSchema(db);
  db.exec(CREATE_MIGRATED_INDEXES_SQL);

  const insertStmt = db.prepare(`
    INSERT INTO orders (
      order_hash, reactor, swapper, nonce, deadline,
      decay_start_time, decay_end_time,
      input_token, input_start_amount, input_end_amount,
      output_token, output_start_amount, output_end_amount, output_recipient,
      encoded_order, signature, status,
      strategy_type, trigger_price, trigger_direction
    ) VALUES (
      @order_hash, @reactor, @swapper, @nonce, @deadline,
      @decay_start_time, @decay_end_time,
      @input_token, @input_start_amount, @input_end_amount,
      @output_token, @output_start_amount, @output_end_amount, @output_recipient,
      @encoded_order, @signature, @status,
      @strategy_type, @trigger_price, @trigger_direction
    )
  `);

  const findByHashStmt = db.prepare(`SELECT * FROM orders WHERE order_hash = ?`);

  const updateStatusStmt = db.prepare(`
    UPDATE orders
    SET status = @status,
        fill_tx_hash = COALESCE(@fill_tx_hash, fill_tx_hash),
        fill_block_number = COALESCE(@fill_block_number, fill_block_number),
        cancel_tx_hash = COALESCE(@cancel_tx_hash, cancel_tx_hash),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE order_hash = @order_hash
  `);

  return {
    insertOrder(order: StoredOrder): void {
      insertStmt.run({
        order_hash: order.orderHash.toLowerCase(),
        reactor: order.reactor.toLowerCase(),
        swapper: order.swapper.toLowerCase(),
        nonce: order.nonce,
        deadline: order.deadline,
        decay_start_time: order.decayStartTime,
        decay_end_time: order.decayEndTime,
        input_token: order.inputToken.toLowerCase(),
        input_start_amount: order.inputStartAmount,
        input_end_amount: order.inputEndAmount,
        output_token: order.outputToken.toLowerCase(),
        output_start_amount: order.outputStartAmount,
        output_end_amount: order.outputEndAmount,
        output_recipient: order.outputRecipient.toLowerCase(),
        encoded_order: order.encodedOrder,
        signature: order.signature,
        status: order.status,
        strategy_type: order.strategyType,
        trigger_price: order.triggerPrice ?? null,
        trigger_direction: order.triggerDirection ?? null,
      });
    },

    findByHash(orderHash: string): StoredOrder | null {
      const row = findByHashStmt.get(orderHash.toLowerCase()) as OrderRow | undefined;
      return row ? rowToOrder(row) : null;
    },

    listOrders(filter: OrderFilter): StoredOrder[] {
      const where: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter.status) {
        where.push(`status = @status`);
        params.status = filter.status;
      }
      if (filter.swapper) {
        where.push(`swapper = @swapper`);
        params.swapper = filter.swapper.toLowerCase();
      }
      if (filter.inputToken) {
        where.push(`input_token = @input_token`);
        params.input_token = filter.inputToken.toLowerCase();
      }
      if (filter.outputToken) {
        where.push(`output_token = @output_token`);
        params.output_token = filter.outputToken.toLowerCase();
      }
      if (filter.strategyType) {
        where.push(`strategy_type = @strategy_type`);
        params.strategy_type = filter.strategyType;
      }
      if (filter.minDeadline !== undefined) {
        where.push(`deadline >= @min_deadline`);
        params.min_deadline = filter.minDeadline;
      }

      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit = Math.min(filter.limit ?? 100, 500);
      const offset = filter.offset ?? 0;

      const sql = `SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      const rows = db.prepare(sql).all(params) as OrderRow[];
      return rows.map(rowToOrder);
    },

    updateStatus(
      orderHash: string,
      status: OrderStatus,
      extra?: { fillTxHash?: string; fillBlockNumber?: number; cancelTxHash?: string },
    ): boolean {
      const info = updateStatusStmt.run({
        order_hash: orderHash.toLowerCase(),
        status,
        fill_tx_hash: extra?.fillTxHash ?? null,
        fill_block_number: extra?.fillBlockNumber ?? null,
        cancel_tx_hash: extra?.cancelTxHash ?? null,
      });
      return info.changes > 0;
    },

    close(): void {
      db.close();
    },
  };
}
