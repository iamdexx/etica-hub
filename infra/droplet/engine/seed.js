// The engine resumes from the highest block in `blocks` and crashes on an
// empty table, so a fresh database is seeded with one recent block. It then
// walks forward from there; set SEED_LOOKBACK_BLOCKS to backfill more history.
const knex = require('./db/knex.js');

async function rpc(method, params) {
  const res = await fetch(process.env.MAIN_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function main() {
  const [{ count }] = await knex('blocks').count({ count: '*' });
  if (Number(count) > 0) {
    console.log(`seed: blocks table already has ${count} rows, nothing to do`);
    return;
  }
  const lookback = Number(process.env.SEED_LOOKBACK_BLOCKS ?? 5000);
  const head = Number(await rpc('eth_blockNumber', []));
  const start = Math.max(0, head - lookback);
  const b = await rpc('eth_getBlockByNumber', ['0x' + start.toString(16), false]);
  await knex('blocks').insert({
    number: Number(b.number),
    hash: b.hash,
    parenthash: b.parentHash,
    nonce: b.nonce,
    sha3Uncles: b.sha3Uncles,
    logsBloom: b.logsBloom,
    transactionsRoot: b.transactionsRoot,
    stateRoot: b.stateRoot,
    miner: b.miner,
    difficulty: String(Number(b.difficulty)),
    totalDifficulty: String(BigInt(b.totalDifficulty)),
    extraData: b.extraData,
    size: Number(b.size),
    gasLimit: Number(b.gasLimit),
    gasUsed: Number(b.gasUsed),
    timestamp: Number(b.timestamp),
    nbtxs: b.transactions.length,
  });
  console.log(`seed: inserted block ${start} (head ${head}); engine will sync forward from here`);
}

main()
  .then(() => knex.destroy())
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  });
