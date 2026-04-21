import 'dotenv/config';
import { createPublicClient, http, type PublicClient } from 'viem';
import {
  eticaCrucible,
  eticaLocalFork,
  eticaMainnet,
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  abis,
  type SupportedChainId,
} from '@etica-hub/shared';
import { runResearchIndexer } from './research';
import { openPriceDb } from './prices/db';
import { createPriceIndexer, type TrackedPair } from './prices/price';
import { buildPriceServer } from './prices/server';

/**
 * Indexer entry point.
 *
 * Selects a module via $INDEXER_MODULE:
 *   - "status"   (default): print boot info + exit
 *   - "research": Research Hub indexer (proposals + events)
 *   - "prices":   price indexer — watches Swap events on ETX-paired pools,
 *                 maintains OHLC candles + latest-price rows in SQLite, and
 *                 exposes them via a small Fastify HTTP API.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID ?? '61803') as SupportedChainId;
const MODULE = (process.env.INDEXER_MODULE ?? 'status') as 'status' | 'research' | 'prices';

function getChain(id: SupportedChainId) {
  if (id === eticaMainnet.id) return eticaMainnet;
  if (id === eticaCrucible.id) return eticaCrucible;
  if (id === eticaLocalFork.id) return eticaLocalFork;
  throw new Error(`unsupported chain id: ${id}`);
}

function getRpcUrl(id: SupportedChainId): string | undefined {
  if (id === eticaMainnet.id) return process.env.ETICA_MAINNET_RPC_URL;
  if (id === eticaCrucible.id) return process.env.ETICA_CRUCIBLE_RPC_URL;
  // Local anvil fork: env override wins, otherwise fall through to chain default.
  if (id === eticaLocalFork.id) return process.env.ETICA_LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
  return undefined;
}

async function resolveTrackedPairs(
  client: PublicClient,
  chainId: SupportedChainId,
): Promise<TrackedPair[]> {
  const dep = DEPLOYMENTS[chainId];
  const ext = EXTERNAL_ADDRESSES[chainId];
  const results: TrackedPair[] = [];

  const candidates: Array<{ id: string; other: `0x${string}`; otherDecimals: number }> = [
    // Every tracked pair is `<spoke>/ETX`. ETX is always the quote (hub-and-spoke).
    { id: 'ETI-ETX', other: ext.eti, otherDecimals: 18 },
    { id: 'EGAZ-ETX', other: dep.wegaz, otherDecimals: 18 },
  ];

  for (const c of candidates) {
    if (c.other === '0x0000000000000000000000000000000000000000') continue;
    if (dep.swapFactory === '0x0000000000000000000000000000000000000000') continue;
    const pair = (await client.readContract({
      address: dep.swapFactory,
      abi: abis.factoryAbi,
      functionName: 'getPair',
      args: [c.other, dep.etx],
    })) as `0x${string}`;
    if (pair === '0x0000000000000000000000000000000000000000') continue;

    const [t0, t1] = (await Promise.all([
      client.readContract({ address: pair, abi: abis.pairAbi, functionName: 'token0' }),
      client.readContract({ address: pair, abi: abis.pairAbi, functionName: 'token1' }),
    ])) as [`0x${string}`, `0x${string}`];

    results.push({
      pairId: c.id,
      pairAddress: pair,
      token0: t0,
      token1: t1,
      baseToken: c.other,
      quoteToken: dep.etx,
      baseDecimals: c.otherDecimals,
      quoteDecimals: 18,
    });
  }

  return results;
}

async function main(): Promise<void> {
  const chain = getChain(CHAIN_ID);
  const rpcUrl = getRpcUrl(chain.id);

  const client = createPublicClient({
    chain,
    transport: rpcUrl ? http(rpcUrl) : http(),
  }) as PublicClient;

  const [blockNumber, chainId] = await Promise.all([client.getBlockNumber(), client.getChainId()]);

  const external = EXTERNAL_ADDRESSES[chain.id as SupportedChainId];

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'indexer.boot',
      module: MODULE,
      chain: chain.name,
      chainId,
      tipBlock: blockNumber.toString(),
      watching: {
        eticaCore: external.eticaCore,
        etiToken: external.eti,
      },
    }),
  );

  if (MODULE === 'research') {
    await runResearchIndexer({ client, chain, chainId: chain.id, previewCount: 5 });
    // Keep the process alive for watchers; otherwise viem stops polling.
    await new Promise<void>(() => {});
    return;
  }

  if (MODULE === 'prices') {
    const pairs = await resolveTrackedPairs(client, chain.id as SupportedChainId);
    if (pairs.length === 0) {
      console.error('[prices] no tracked pairs resolved — check DEPLOYMENTS and factory state');
      return;
    }
    const dbPath = process.env.PRICES_DB_PATH ?? './data/prices.db';
    const db = openPriceDb(dbPath);
    const startBlock = BigInt(process.env.PRICES_START_BLOCK ?? '0');
    const blockBatchSize = parseInt(process.env.PRICES_BLOCK_BATCH_SIZE ?? '5000', 10);
    const pollIntervalMs = Math.max(
      parseInt(process.env.PRICES_POLL_INTERVAL_MS ?? '15000', 10),
      1,
    );
    const httpPort = parseInt(process.env.PRICES_HTTP_PORT ?? '3200', 10);
    const httpHost = process.env.PRICES_HTTP_HOST ?? '0.0.0.0';

    const indexer = createPriceIndexer({
      client,
      db,
      pairs,
      blockBatchSize,
      startBlock,
      pollIntervalMs,
    });

    const server = await buildPriceServer({
      db,
      pairIds: pairs.map((p) => p.pairId),
      logger: true,
    });

    const shutdown = async (sig: string): Promise<void> => {
      console.log(`[prices] received ${sig}, shutting down`);
      indexer.stop();
      await server.close();
      db.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await server.listen({ port: httpPort, host: httpHost });
    console.log(`[prices] http listening on ${httpHost}:${httpPort}`);
    console.log(
      `[prices] tracking pairs: ${pairs.map((p) => `${p.pairId}@${p.pairAddress}`).join(', ')}`,
    );

    await indexer.start();
    return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
