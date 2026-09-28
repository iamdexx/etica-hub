/**
 * Deploy EticaResearchMarketplace from the keeper EOA (GitHub Actions,
 * workflow_dispatch). The contract has no owner or admin, so the deployer
 * gains nothing but the gas bill; what matters is the two constructor
 * arguments, which are immutable and verified back from chain before the
 * address is printed.
 *
 * Env:
 *   HARVEST_PRIVATE_KEY           gas-paying signer (farm keeper EOA)
 *   HARVEST_RPC_URL / HARVEST_CHAIN_ID
 *   MARKETPLACE_NFT_ADDRESS       EticaResearchNFT the marketplace trades
 *   MARKETPLACE_ABANDONED_PRICE_BPS
 *                                 auto-listing price as bps of the record's
 *                                 mint fee (20000 = 2x)
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abis } from '@etica-hub/shared';

import { DEFAULT_NFT } from '../forfeit/config.js';

export const DEFAULT_ABANDONED_PRICE_BPS = 20_000n;

const ARTIFACT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../web/src/lib/etica-research-marketplace-artifact.json',
);

interface Artifact {
  bytecode: Hex;
}

export function loadArtifactBytecode(path: string = ARTIFACT_PATH): Hex {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Artifact;
  if (!isHex(parsed.bytecode) || parsed.bytecode.length < 4) {
    throw new Error(`marketplace artifact at ${path} has no bytecode`);
  }
  return parsed.bytecode;
}

export interface DeployConfig {
  rpcUrl: string;
  chainId: number;
  nft: Address;
  abandonedPriceBps: bigint;
  privateKey: Hex;
}

export function loadDeployConfig(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  const pk = env.HARVEST_PRIVATE_KEY;
  if (!pk || !isHex(pk)) throw new Error('HARVEST_PRIVATE_KEY must be 0x-prefixed hex');
  const nft = env.MARKETPLACE_NFT_ADDRESS ?? DEFAULT_NFT;
  if (!isAddress(nft)) throw new Error(`MARKETPLACE_NFT_ADDRESS is not an address: ${nft}`);
  const bpsRaw = env.MARKETPLACE_ABANDONED_PRICE_BPS;
  const bps = bpsRaw ? BigInt(bpsRaw) : DEFAULT_ABANDONED_PRICE_BPS;
  if (bps <= 0n || bps > 1_000_000n) {
    throw new Error(`MARKETPLACE_ABANDONED_PRICE_BPS must be in (0, 1e6], got ${bpsRaw}`);
  }
  return {
    rpcUrl: env.HARVEST_RPC_URL ?? 'https://rpc2.etica-stats.org',
    chainId: Number(env.HARVEST_CHAIN_ID ?? '61803'),
    nft: nft as Address,
    abandonedPriceBps: bps,
    privateKey: pk as Hex,
  };
}

export async function deployMarketplace(
  config: DeployConfig,
  log: Pick<Console, 'info' | 'error'> = console,
): Promise<Address> {
  const chain = defineChain({
    id: config.chainId,
    name: 'Etica',
    nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(config.rpcUrl) });

  const nftCode = await publicClient.getCode({ address: config.nft });
  if (!nftCode || nftCode === '0x') throw new Error(`no contract at NFT address ${config.nft}`);

  log.info(
    `[marketplace:deploy] deployer=${account.address} nft=${config.nft} ` +
      `abandonedPriceBps=${config.abandonedPriceBps} chain=${config.chainId}`,
  );

  const hash = await walletClient.deployContract({
    abi: abis.eticaResearchMarketplaceAbi,
    bytecode: loadArtifactBytecode(),
    args: [config.nft, config.abandonedPriceBps],
  });
  log.info(`[marketplace:deploy] tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deploy transaction ${hash} failed`);
  }
  const address = receipt.contractAddress;

  const [nft, research, bps] = await Promise.all([
    publicClient.readContract({ address, abi: abis.eticaResearchMarketplaceAbi, functionName: 'nft' }),
    publicClient.readContract({ address, abi: abis.eticaResearchMarketplaceAbi, functionName: 'research' }),
    publicClient.readContract({
      address,
      abi: abis.eticaResearchMarketplaceAbi,
      functionName: 'abandonedPriceBps',
    }),
  ]);
  if (nft.toLowerCase() !== config.nft.toLowerCase() || research.toLowerCase() !== config.nft.toLowerCase()) {
    throw new Error(`deployed marketplace ${address} points at ${nft}, expected ${config.nft}`);
  }
  if (bps !== config.abandonedPriceBps) {
    throw new Error(`deployed marketplace ${address} has bps=${bps}, expected ${config.abandonedPriceBps}`);
  }

  log.info(`[marketplace:deploy] EticaResearchMarketplace deployed at ${address}`);
  log.info(`[marketplace:deploy] add to packages/shared/src/addresses.ts: eticaResearchMarketplace: '${address}'`);
  return address;
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/keeper/src/marketplace/deploy.ts') ||
    process.argv[1].endsWith('/keeper/dist/marketplace/deploy.js'));

if (invokedAsScript) {
  deployMarketplace(loadDeployConfig()).catch((err) => {
    console.error('[marketplace:deploy] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
