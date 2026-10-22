import type { Pool } from 'pg';

export const SCHEMA_SQL = `
create schema if not exists hub;
create table if not exists hub.blocks (
  number bigint primary key, hash text not null, parent_hash text not null, miner text not null,
  ts bigint not null, gas_used bigint not null, gas_limit bigint not null, tx_count int not null,
  base_fee numeric, size int
);
create table if not exists hub.txs (
  hash text primary key, block bigint not null references hub.blocks(number) on delete cascade,
  idx int not null, ts bigint not null, "from" text not null, "to" text, created text,
  value numeric not null, gas bigint not null, gas_used bigint, gas_price numeric, nonce bigint not null,
  input bytea, method text, status smallint, type text
);
create index if not exists txs_from_block on hub.txs ("from", block desc, idx desc);
create index if not exists txs_to_block on hub.txs ("to", block desc, idx desc);
create index if not exists txs_created on hub.txs (created) where created is not null;
create index if not exists txs_block on hub.txs (block desc, idx desc);
create table if not exists hub.logs (
  block bigint not null references hub.blocks(number) on delete cascade, log_index int not null,
  tx text not null, tx_index int not null, address text not null, topic0 text, topic1 text, topic2 text, topic3 text,
  data bytea, ts bigint not null, primary key (block, log_index)
);
create index if not exists logs_address on hub.logs (address, block desc, log_index desc);
create index if not exists logs_topic0 on hub.logs (topic0, block desc);
create table if not exists hub.token_transfers (
  block bigint not null references hub.blocks(number) on delete cascade, log_index int not null,
  tx text not null, ts bigint not null, token text not null, "from" text not null, "to" text not null,
  value numeric not null, token_id numeric, primary key (block, log_index)
);
create index if not exists tt_from on hub.token_transfers ("from", block desc);
create index if not exists tt_to on hub.token_transfers ("to", block desc);
create index if not exists tt_token on hub.token_transfers (token, block desc);
create table if not exists hub.token_balances (
  token text not null, holder text not null, balance numeric not null, updated_block bigint not null,
  primary key (token, holder)
);
create index if not exists tb_token_balance on hub.token_balances (token, balance desc);
create table if not exists hub.address_stats (
  address text primary key, tx_count bigint not null default 0, first_block bigint, last_block bigint,
  is_contract boolean not null default false
);
create table if not exists hub.daily (
  day date primary key, txs bigint not null, blocks bigint not null, gas_used numeric not null,
  fees_wei numeric not null, active_addresses bigint not null, transfers bigint not null
);
create table if not exists hub.cursor (id int primary key default 1 check (id = 1), head bigint not null, updated_at timestamptz not null default now());
`;

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
