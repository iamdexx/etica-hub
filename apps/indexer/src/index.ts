import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import {
  eticaCrucible,
  eticaLocalFork,
  eticaMainnet,
  EXTERNAL_ADDRESSES,
  type SupportedChainId,
} from '@etica-hub/shared';

/**
 * Skeleton indexer.
 *
 * Phase 1 scope (EticaSwap):
 *   - listen for PairCreated on the factory
 *   - per pair, listen for Mint / Burn / Swap / Sync
 *   - persist to Postgres (added in follow-up PR)
 *
 * Phase 2 scope (Research Hub):
 *   - listen for proposal events on EXTERNAL_ADDRESSES.eticaCore
 *   - resolve IPFS hashes and cache rendered content
 *
 * For now this file just boots a viem client and prints the tip block on
 * whichever chain was picked via $CHAIN_ID. It's wired into the monorepo so
 * the PR ships a runnable scaffold.
 */

const CHAIN_ID = Number(process.env.CHAIN_ID ?? '61888') as SupportedChainId;

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
  if (id === eticaLocalFork.id)
    return process.env.ETICA_LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
  return undefined;
}

async function main(): Promise<void> {
  const chain = getChain(CHAIN_ID);
  const rpcUrl = getRpcUrl(chain.id);

  const client = createPublicClient({
    chain,
    transport: rpcUrl ? http(rpcUrl) : http(),
  });

  const [blockNumber, chainId] = await Promise.all([
    client.getBlockNumber(),
    client.getChainId(),
  ]);

  const external = EXTERNAL_ADDRESSES[chain.id as SupportedChainId];

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        module: 'indexer',
        chain: chain.name,
        chainId,
        tipBlock: blockNumber.toString(),
        watching: {
          eticaCore: external.eticaCore,
          etiToken: external.eti,
        },
        note: 'indexer skeleton — event listeners ship with Phase 1 / Phase 2 implementation.',
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
