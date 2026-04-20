import 'dotenv/config';
import { createPublicClient, http, type PublicClient } from 'viem';
import {
  eticaCrucible,
  eticaLocalFork,
  eticaMainnet,
  EXTERNAL_ADDRESSES,
  type SupportedChainId,
} from '@etica-hub/shared';
import { runResearchIndexer } from './research';

/**
 * Indexer entry point.
 *
 * Selects a module via $INDEXER_MODULE:
 *   - "status"   (default): print boot info + exit
 *   - "research": Research Hub indexer (proposals + events)
 *
 * Phase 1 scope (EticaSwap pair events) ships in a follow-up PR once we
 * decide on the store (SQLite / Postgres).
 */

const CHAIN_ID = Number(process.env.CHAIN_ID ?? '61803') as SupportedChainId;
const MODULE = (process.env.INDEXER_MODULE ?? 'status') as 'status' | 'research';

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
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
