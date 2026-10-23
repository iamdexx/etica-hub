import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import { isAddress } from 'viem';

type Q = Record<string, string | undefined>;
const ok = (result: unknown) => ({ status: '1', message: 'OK', result });
const err = (message: string, result: unknown = null) => ({ status: '0', message, result });
const addr = (v?: string) => (v && isAddress(v, { strict: false }) ? v.toLowerCase() : null);
const num = (v: string | undefined, d: number, max: number) =>
  Math.min(Math.max(Number.parseInt(v ?? '', 10) || d, 1), max);
const hex = (b: Buffer | null) => `0x${(b ?? Buffer.alloc(0)).toString('hex')}`;

function txRow(r: Record<string, string | Buffer | null>) {
  return {
    blockNumber: String(r.block),
    timeStamp: String(r.ts),
    hash: r.hash,
    nonce: String(r.nonce),
    transactionIndex: String(r.idx),
    from: r.from,
    to: r.to ?? '',
    value: String(r.value),
    gas: String(r.gas),
    gasPrice: String(r.gas_price ?? '0'),
    isError: String(r.status) === '0' ? '1' : '0',
    txreceipt_status: String(r.status ?? ''),
    input: hex(r.input as Buffer | null),
    contractAddress: r.created ?? '',
    gasUsed: String(r.gas_used ?? ''),
    methodId: r.method ?? '',
    functionName: '',
  };
}

export function buildApi(pool: Pool) {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });
  app.get('/health', async () => {
    const cur = await pool.query(
      'select head, extract(epoch from updated_at) as upd from hub.cursor where id = 1',
    );
    return {
      ok: true,
      head: cur.rows[0] ? Number(cur.rows[0].head) : null,
      updatedAt: cur.rows[0] ? Number(cur.rows[0].upd) : null,
    };
  });
  app.get('/api', async (req, reply) => {
    const qs = req.query as Q;
    const page = num(qs.page, 1, 10_000);
    const offset = num(qs.offset, 50, 1000);
    const sort = qs.sort === 'asc' ? 'asc' : 'desc';
    const key = `${qs.module}:${qs.action}`;
    try {
      switch (key) {
        case 'account:txlist': {
          const a = addr(qs.address);
          if (!a) return err('Error! Invalid address format');
          const r = await pool.query(
            `select * from hub.txs where ("from" = $1 or "to" = $1 or created = $1) and block between $2 and $3
             order by block ${sort}, idx ${sort} limit $4 offset $5`,
            [a, qs.startblock ?? 0, qs.endblock ?? 99_999_999_999, offset, (page - 1) * offset],
          );
          return r.rows.length ? ok(r.rows.map(txRow)) : err('No transactions found', []);
        }
        case 'account:tokentx':
        case 'account:tokennfttx': {
          const a = addr(qs.address);
          const token = addr(qs.contractaddress);
          if (!a && !token) return err('Error! Missing address or contractaddress');
          const nft = key === 'account:tokennfttx';
          const r = await pool.query(
            `select t.*, x.nonce, x.gas, x.gas_price, x.gas_used, x.idx from hub.token_transfers t join hub.txs x on x.hash = t.tx
             where ($1::text is null or t."from" = $1 or t."to" = $1) and ($2::text is null or t.token = $2) and (t.token_id is ${nft ? 'not' : ''} null)
             order by t.block ${sort}, t.log_index ${sort} limit $3 offset $4`,
            [a, token, offset, (page - 1) * offset],
          );
          return r.rows.length
            ? ok(
                r.rows.map((t) => ({
                  blockNumber: String(t.block),
                  timeStamp: String(t.ts),
                  hash: t.tx,
                  nonce: String(t.nonce),
                  from: t.from,
                  to: t.to,
                  contractAddress: t.token,
                  value: String(t.value),
                  tokenID: t.token_id === null ? undefined : String(t.token_id),
                  transactionIndex: String(t.idx),
                  gas: String(t.gas),
                  gasPrice: String(t.gas_price),
                  gasUsed: String(t.gas_used),
                  logIndex: String(t.log_index),
                })),
              )
            : err('No transactions found', []);
        }
        case 'account:txcount': {
          const a = addr(qs.address);
          if (!a) return err('Error! Invalid address format');
          const r = await pool.query(
            'select tx_count, first_block, last_block from hub.address_stats where address = $1',
            [a],
          );
          return ok({
            count: String(r.rows[0]?.tx_count ?? 0),
            firstBlock: r.rows[0]?.first_block ?? null,
            lastBlock: r.rows[0]?.last_block ?? null,
          });
        }
        case 'account:tokenbalance': {
          const a = addr(qs.address);
          const token = addr(qs.contractaddress);
          if (!a || !token) return err('Error! Invalid address format');
          const r = await pool.query(
            'select balance from hub.token_balances where token = $1 and holder = $2',
            [token, a],
          );
          return ok(String(r.rows[0]?.balance ?? '0'));
        }
        case 'token:tokenholderlist': {
          const token = addr(qs.contractaddress);
          if (!token) return err('Error! Invalid contractaddress format');
          const r = await pool.query(
            `select holder, balance from hub.token_balances where token = $1 and balance > 0 order by balance desc limit $2 offset $3`,
            [token, offset, (page - 1) * offset],
          );
          return ok(
            r.rows.map((h) => ({
              TokenHolderAddress: h.holder,
              TokenHolderQuantity: String(h.balance),
            })),
          );
        }
        case 'token:tokenholdercount': {
          const token = addr(qs.contractaddress);
          if (!token) return err('Error! Invalid contractaddress format');
          const r = await pool.query(
            'select count(*) from hub.token_balances where token = $1 and balance > 0',
            [token],
          );
          return ok(String(r.rows[0].count));
        }
        case 'logs:getLogs': {
          const a = addr(qs.address);
          const topics = [qs.topic0, qs.topic1, qs.topic2, qs.topic3].map((t) =>
            t && /^0x[0-9a-fA-F]{64}$/.test(t) ? t.toLowerCase() : null,
          );
          if (!a && !topics[0]) return err('Error! address or topic0 is required');
          const r = await pool.query(
            `select * from hub.logs where ($1::text is null or address = $1) and ($2::text is null or topic0 = $2) and ($3::text is null or topic1 = $3)
             and ($4::text is null or topic2 = $4) and ($5::text is null or topic3 = $5) and block between $6 and $7
             order by block ${sort}, log_index ${sort} limit $8 offset $9`,
            [
              a,
              ...topics,
              qs.fromBlock ?? 0,
              qs.toBlock ?? 99_999_999_999,
              offset,
              (page - 1) * offset,
            ],
          );
          return r.rows.length
            ? ok(
                r.rows.map((l) => ({
                  address: l.address,
                  topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter(Boolean),
                  data: hex(l.data),
                  blockNumber: `0x${Number(l.block).toString(16)}`,
                  timeStamp: `0x${Number(l.ts).toString(16)}`,
                  logIndex: `0x${Number(l.log_index).toString(16)}`,
                  transactionHash: l.tx,
                  transactionIndex: `0x${Number(l.tx_index).toString(16)}`,
                })),
              )
            : err('No records found', []);
        }
        case 'stats:daily': {
          const r = await pool.query(
            `select to_char(to_timestamp(ts)::date, 'YYYY-MM-DD') as day, count(*) as txs, count(distinct block) as blocks,
             sum(gas_used) as gas_used, sum(gas_used * gas_price) as fees_wei, count(distinct "from") as senders
             from hub.txs where ts >= extract(epoch from now() - make_interval(days => $1))::bigint group by 1 order by 1`,
            [num(qs.days, 30, 3650)],
          );
          return ok(
            r.rows.map((d) => ({
              ...d,
              txs: String(d.txs),
              blocks: String(d.blocks),
              gas_used: String(d.gas_used),
              fees_wei: String(d.fees_wei),
              senders: String(d.senders),
            })),
          );
        }
        case 'stats:indexer': {
          const r = await pool.query('select head, updated_at from hub.cursor where id = 1');
          const c = await pool.query(
            'select (select count(*) from hub.txs) as txs, (select count(*) from hub.blocks) as blocks, (select count(*) from hub.token_transfers) as transfers',
          );
          return ok({
            head: r.rows[0]?.head ?? null,
            updatedAt: r.rows[0]?.updated_at ?? null,
            ...c.rows[0],
          });
        }
        default:
          return err('Error! Missing or unsupported module/action');
      }
    } catch (e) {
      reply.code(500);
      return err(`Error! ${e instanceof Error ? e.message : 'query failed'}`);
    }
  });
  return app;
}
