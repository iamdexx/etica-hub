/**
 * CLI: bulk-register — scan an entire ERC-721 collection and mint TRON twins.
 *
 * Usage:
 *   pnpm bulk-register \
 *     --contract 0x... \
 *     --rpc https://rpc2.etica-stats.org \
 *     --tron-recipient 0x... \
 *     --payout-wallet 0x...
 *
 * The command enumerates every tokenId from the given ERC-721 contract, dedupes
 * against already-minted twins on TRON, and runs the keeper's entry planner +
 * executor for the missing ones. Respects dry-run mode (default when no keys
 * are set).
 */

import 'dotenv/config';
import { isAddress, type Address } from 'viem';
import { loadConfig } from './config.js';
import { scanEntireCollection } from './bulk-scanner.js';
import { createKeeper } from './keeper.js';
import { buildPlan, isEmptyPlan } from './planner.js';
import { executePlan } from './executor.js';
import { observe } from './monitor.js';
import type { Hex, Registration } from './types.js';

function usage(): never {
  console.error(
    `Usage: pnpm bulk-register \\
  --contract <ERC721-address> \\
  --rpc <origin-chain-rpc-url> \\
  --tron-recipient <0x-TRON-address> \\
  --payout-wallet <0x-Etica-address>`,
  );
  process.exit(1);
}

function parseArgs(argv: string[]): {
  contract: Address;
  rpc: string;
  tronRecipient: Hex;
  payoutWallet: Hex;
} {
  const args = argv.slice(2);
  let contract = '';
  let rpc = '';
  let tronRecipient = '';
  let payoutWallet = '';

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1] ?? '';
    switch (args[i]) {
      case '--contract':
        contract = next;
        i++;
        break;
      case '--rpc':
        rpc = next;
        i++;
        break;
      case '--tron-recipient':
        tronRecipient = next;
        i++;
        break;
      case '--payout-wallet':
        payoutWallet = next;
        i++;
        break;
      default:
        console.error(`Unknown flag: ${args[i]}`);
        usage();
    }
  }

  if (!contract || !rpc || !tronRecipient || !payoutWallet) usage();
  if (!isAddress(contract)) {
    console.error(`--contract is not a valid address: ${contract}`);
    process.exit(1);
  }

  return {
    contract: contract as Address,
    rpc,
    tronRecipient: tronRecipient as Hex,
    payoutWallet: payoutWallet as Hex,
  };
}

async function main(): Promise<void> {
  const { contract, rpc, tronRecipient, payoutWallet } = parseArgs(process.argv);
  const config = loadConfig();
  const log = console;

  log.info(`[bulk-register] contract=${contract} rpc=${rpc}`);
  log.info(`[bulk-register] tronRecipient=${tronRecipient} payoutWallet=${payoutWallet}`);
  log.info(`[bulk-register] mode=${config.dryRun ? 'DRY-RUN' : 'LIVE'}`);

  // 1. Scan the entire collection from the origin chain
  const allTokens = await scanEntireCollection({
    rpcUrl: rpc,
    contractAddress: contract,
    tronRecipient,
    payoutWallet,
    log,
  });

  if (allTokens.length === 0) {
    log.info('[bulk-register] no tokens found in collection — nothing to do');
    return;
  }

  // 2. Build a keeper to get the TRON adapter (for dedup + minting)
  const keeper = createKeeper(config, log);

  // 3. Observe current TRON state (which twins already exist)
  const baseObs = await observe(keeper.etica, keeper.tron, log);

  // 4. Merge the scanned tokens into the observation as registrations
  const mergedRegistrations: Registration[] = allTokens;
  const observation = {
    ...baseObs,
    registrations: mergedRegistrations,
  };

  // 5. Build + execute the plan (planner dedupes against mintedByResTokenId)
  const plan = buildPlan(observation, {
    initialFrontSun: config.initialFrontSun,
    minPayoutSun: config.minPayoutSun,
    reserveTopUpBps: config.reserveTopUpBps,
    keeperOpsBps: config.keeperOpsBps,
  });

  const newEntries = plan.entries.length;
  const alreadyMinted = allTokens.length - newEntries;

  log.info(
    `[bulk-register] ${allTokens.length} total tokens, ` +
      `${alreadyMinted} already minted, ${newEntries} new to mint`,
  );

  if (isEmptyPlan(plan)) {
    log.info('[bulk-register] all tokens already have twins — nothing to do');
    return;
  }

  const report = await executePlan(plan, {
    config,
    etica: keeper.etica,
    tron: keeper.tron,
    log,
  });

  log.info(
    `[bulk-register] done: minted=${report.minted} fronted=${report.fronted} ` +
      `skipped=${report.skipped}`,
  );
}

main().catch((err) => {
  console.error('[bulk-register] fatal:', err);
  process.exitCode = 1;
});
