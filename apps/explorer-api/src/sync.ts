import type { Pool, PoolClient } from 'pg';
import type { Block, PublicClient, TransactionReceipt } from 'viem';
import { decodeTransfer, isBurn, isMint } from './decode.js';

export interface SyncOptions {
  startBlock: number;
  batch: number;
  confirmations: number;
  log: (msg: string) => void;
}

const q = (c: PoolClient, text: string, values?: unknown[]) => c.query(text, values);

/** Index blocks [from, to] inside one transaction; a reorg deletes >= from first. */
export async function indexRange(
  pool: Pool,
  client: PublicClient,
  from: number,
  to: number,
  opts: SyncOptions,
): Promise<void> {
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i));
  const blocks = await Promise.all(
    numbers.map((n) => client.getBlock({ blockNumber: n, includeTransactions: true })),
  );
  const receipts = await Promise.all(
    blocks.map((b) =>
      b.transactions.length
        ? ((client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({
            method: 'eth_getBlockReceipts',
            params: [`0x${b.number!.toString(16)}`],
          }) as Promise<TransactionReceipt[] | null>)
        : Promise.resolve([]),
    ),
  );
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i]!.parentHash !== blocks[i - 1]!.hash)
      throw new Error(`parent mismatch at ${blocks[i]!.number}`);
  }
  const c = await pool.connect();
  try {
    await q(c, 'begin');
    const prev = await q(c, 'select hash from hub.blocks where number = $1', [from - 1]);
    if (prev.rows[0] && prev.rows[0].hash !== blocks[0]!.parentHash) {
      await q(c, 'rollback');
      c.release();
      opts.log(`reorg detected at ${from}; rewinding`);
      await rewind(pool, from - 1);
      return indexRange(pool, client, from - 1, to, opts);
    }
    await q(c, 'delete from hub.blocks where number >= $1', [from]);
    for (let i = 0; i < blocks.length; i++) await writeBlock(c, blocks[i]!, receipts[i] ?? []);
    await q(
      c,
      `insert into hub.cursor (id, head, updated_at) values (1, $1, now())
      on conflict (id) do update set head = excluded.head, updated_at = now()`,
      [to],
    );
    await q(c, 'commit');
  } catch (e) {
    await q(c, 'rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function rewind(pool: Pool, keepBelow: number): Promise<void> {
  await pool.query('delete from hub.blocks where number >= $1', [keepBelow]);
  await pool.query('update hub.cursor set head = $1 where id = 1 and head >= $1', [keepBelow - 1]);
}

async function writeBlock(
  c: PoolClient,
  b: Block<bigint, true>,
  receipts: TransactionReceipt[] | null,
): Promise<void> {
  if (b.number === null) throw new Error('pending block');
  const ts = Number(b.timestamp);
  await q(
    c,
    `insert into hub.blocks (number, hash, parent_hash, miner, ts, gas_used, gas_limit, tx_count, base_fee, size)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      b.number.toString(),
      b.hash,
      b.parentHash,
      b.miner.toLowerCase(),
      ts,
      b.gasUsed.toString(),
      b.gasLimit.toString(),
      b.transactions.length,
      b.baseFeePerGas?.toString() ?? null,
      Number(b.size),
    ],
  );
  if (b.transactions.length && (!receipts || receipts.length !== b.transactions.length)) {
    throw new Error(`receipts missing for block ${b.number}`);
  }
  const byHash = new Map((receipts ?? []).map((r) => [r.transactionHash.toLowerCase(), r]));
  const touched = new Map<string, { count: number }>();
  const balanceDelta = new Map<string, bigint>();
  for (const tx of b.transactions) {
    const r = byHash.get(tx.hash.toLowerCase());
    if (!r) throw new Error(`receipt missing ${tx.hash}`);
    const from = tx.from.toLowerCase();
    const to = tx.to?.toLowerCase() ?? null;
    const created = r.contractAddress?.toLowerCase() ?? null;
    const method = tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null;
    await q(
      c,
      `insert into hub.txs (hash, block, idx, ts, "from", "to", created, value, gas, gas_used, gas_price, nonce, input, method, status, type)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        tx.hash.toLowerCase(),
        b.number.toString(),
        tx.transactionIndex,
        ts,
        from,
        to,
        created,
        tx.value.toString(),
        tx.gas.toString(),
        r.gasUsed.toString(),
        (r.effectiveGasPrice ?? tx.gasPrice ?? 0n).toString(),
        tx.nonce,
        Buffer.from(tx.input.slice(2), 'hex'),
        method,
        r.status === 'success' ? 1 : 0,
        tx.type,
      ],
    );
    for (const a of [from, to, created])
      if (a) touched.set(a, { count: (touched.get(a)?.count ?? 0) + 1 });
    for (const log of r.logs) {
      await q(
        c,
        `insert into hub.logs (block, log_index, tx, tx_index, address, topic0, topic1, topic2, topic3, data, ts)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          b.number.toString(),
          log.logIndex,
          tx.hash.toLowerCase(),
          tx.transactionIndex,
          log.address.toLowerCase(),
          log.topics[0] ?? null,
          log.topics[1] ?? null,
          log.topics[2] ?? null,
          log.topics[3] ?? null,
          Buffer.from(log.data.slice(2), 'hex'),
          ts,
        ],
      );
      const t = decodeTransfer(log);
      if (!t) continue;
      await q(
        c,
        `insert into hub.token_transfers (block, log_index, tx, ts, token, "from", "to", value, token_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          b.number.toString(),
          t.logIndex,
          t.tx,
          ts,
          t.token,
          t.from,
          t.to,
          t.value.toString(),
          t.tokenId?.toString() ?? null,
        ],
      );
      if (t.tokenId !== null) continue;
      if (!isMint(t))
        balanceDelta.set(
          `${t.token}|${t.from}`,
          (balanceDelta.get(`${t.token}|${t.from}`) ?? 0n) - t.value,
        );
      if (!isBurn(t))
        balanceDelta.set(
          `${t.token}|${t.to}`,
          (balanceDelta.get(`${t.token}|${t.to}`) ?? 0n) + t.value,
        );
    }
  }
  for (const [key, delta] of balanceDelta) {
    const [token, holder] = key.split('|') as [string, string];
    await q(
      c,
      `insert into hub.token_balances (token, holder, balance, updated_block) values ($1,$2,$3,$4)
      on conflict (token, holder) do update set balance = hub.token_balances.balance + excluded.balance, updated_block = excluded.updated_block`,
      [token, holder, delta.toString(), b.number.toString()],
    );
  }
  for (const [address, { count }] of touched) {
    await q(
      c,
      `insert into hub.address_stats (address, tx_count, first_block, last_block) values ($1,$2,$3,$3)
      on conflict (address) do update set tx_count = hub.address_stats.tx_count + excluded.tx_count, last_block = excluded.last_block`,
      [address, count, b.number.toString()],
    );
  }
}

export async function syncForever(
  pool: Pool,
  client: PublicClient,
  opts: SyncOptions,
): Promise<never> {
  for (;;) {
    try {
      const cur = await pool.query('select head from hub.cursor where id = 1');
      const next = cur.rows[0] ? Number(cur.rows[0].head) + 1 : opts.startBlock;
      const safeHead = Number(await client.getBlockNumber()) - opts.confirmations;
      if (next > safeHead) {
        await sleep(5_000);
        continue;
      }
      const to = Math.min(safeHead, next + opts.batch - 1);
      await indexRange(pool, client, next, to, opts);
      if (to % 1000 < opts.batch) opts.log(`indexed to ${to} (${safeHead - to} behind)`);
    } catch (e) {
      opts.log(`sync error: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(10_000);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
