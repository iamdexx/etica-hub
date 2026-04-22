/**
 * Harvest runner — reads on-chain state, produces a plan, and either
 * logs it (dry-run) or submits it (live).
 *
 * The runner is intentionally thin: the entire policy lives in
 * `./plan.ts` as pure functions; this file just does I/O.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abis } from '@etica-hub/shared';
import type { HarvestConfig } from './config.js';
import { DEAD_ADDRESS } from './config.js';
import {
  buildHarvestPlan,
  type HarvestAction,
  type HarvestPlan,
  type PairSnapshot,
} from './plan.js';
import { buildDelegationCall, type DelegationCall } from './delegation.js';

const DEADLINE_BUFFER_S = 300; // 5 minutes
const MAX_UINT256 = (1n << 256n) - 1n;

export interface HarvestRunResult {
  skipped: boolean;
  dryRun: boolean;
  /** "delegation" = single harvester.harvest() call; "legacy" = treasury-signed multi-tx. */
  mode: 'delegation' | 'legacy';
  plan: HarvestPlan;
  /** Only populated in delegation mode; the calldata that was (or would be) submitted. */
  delegation?: DelegationCall;
  submittedTxHashes: string[];
  error?: string;
}

/**
 * Snapshot the treasury's position on a single pair. Returns `null` when
 * the pair does not exist on-chain (factory.getPair returns zero).
 */
export async function snapshotPair(
  client: PublicClient,
  factory: Address,
  etx: Address,
  nonEtx: Address,
  label: string,
  treasury: Address,
): Promise<PairSnapshot | null> {
  const pair = (await client.readContract({
    address: factory,
    abi: abis.factoryAbi,
    functionName: 'getPair',
    args: [etx, nonEtx],
  })) as Address;

  if (pair.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return null;
  }

  const [token0Raw, reservesRaw, totalSupplyRaw, treasuryLpRaw] = await Promise.all([
    client.readContract({
      address: pair,
      abi: abis.pairAbi,
      functionName: 'token0',
    }) as Promise<Address>,
    client.readContract({
      address: pair,
      abi: abis.pairAbi,
      functionName: 'getReserves',
    }) as Promise<readonly [bigint, bigint, number]>,
    client.readContract({
      address: pair,
      abi: abis.pairAbi,
      functionName: 'totalSupply',
    }) as Promise<bigint>,
    client.readContract({
      address: pair,
      abi: abis.pairAbi,
      functionName: 'balanceOf',
      args: [treasury],
    }) as Promise<bigint>,
  ]);

  const token0 = token0Raw.toLowerCase();
  const etxIsToken0 = token0 === etx.toLowerCase();
  const reserveEtx = etxIsToken0 ? reservesRaw[0] : reservesRaw[1];
  const reserveNonEtx = etxIsToken0 ? reservesRaw[1] : reservesRaw[0];

  return {
    label,
    pair,
    nonEtx,
    reserveEtx,
    reserveNonEtx,
    totalSupply: totalSupplyRaw,
    treasuryLp: treasuryLpRaw,
  };
}

export function formatAction(a: HarvestAction): string {
  switch (a.kind) {
    case 'approve-lp':
      return `approve-LP ${a.label} lp=${a.amount}`;
    case 'remove-liquidity':
      return `removeLiquidity ${a.label} lp=${a.lpToBurn} minEtxOut=${a.minEtxOut} minNonEtxOut=${a.minNonEtxOut}`;
    case 'approve-erc20':
      return `approve-ERC20 ${a.label} token=${a.token} amount=${a.amount}`;
    case 'swap-to-etx':
      return `swap→ETX ${a.label} in=${a.amountIn} minOut=${a.minEtxOut}`;
    case 'swap-from-etx':
      return `swap←ETX ${a.label} etxIn=${a.etxIn} minOut=${a.minNonEtxOut}`;
    case 'add-liquidity-burn-lp':
      return `addLiquidity+burn ${a.label} etx=${a.etxAmount} non=${a.nonEtxAmount} to=${a.lpRecipient}`;
    case 'distribute-to-staked-etx':
      return `distributeRewards stETX vault=${a.vault} amount=${a.amount}`;
    case 'distribute-to-farms':
      return `distributeRewards farms=${a.farms} amount=${a.amount}`;
    case 'retain-in-treasury':
      return `retain-in-treasury treasury=${a.treasury} amount=${a.amount}`;
  }
}

/**
 * Execute a single plan action against the router / vault / token
 * contracts. Returns the submitted tx hash.
 *
 * This is only called when `config.dryRun === false` and a wallet is
 * provided. Dry-runs go through `logPlan` instead.
 */
async function executeAction(
  a: HarvestAction,
  wallet: WalletClient,
  account: Address,
  config: HarvestConfig,
): Promise<`0x${string}`> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_S);
  switch (a.kind) {
    case 'approve-lp':
      return wallet.writeContract({
        chain: null,
        account,
        address: a.pair,
        abi: abis.pairAbi,
        functionName: 'approve',
        args: [a.spender, MAX_UINT256],
      });
    case 'remove-liquidity':
      return wallet.writeContract({
        chain: null,
        account,
        address: config.router,
        abi: abis.routerAbi,
        functionName: 'removeLiquidity',
        args: [
          config.etx,
          a.nonEtx,
          a.lpToBurn,
          a.minEtxOut,
          a.minNonEtxOut,
          config.treasury,
          deadline,
        ],
      });
    case 'approve-erc20':
      return wallet.writeContract({
        chain: null,
        account,
        address: a.token,
        abi: abis.erc20Abi,
        functionName: 'approve',
        args: [a.spender, MAX_UINT256],
      });
    case 'swap-to-etx':
      return wallet.writeContract({
        chain: null,
        account,
        address: config.router,
        abi: abis.routerAbi,
        functionName: 'swapExactTokensForTokens',
        args: [a.amountIn, a.minEtxOut, [a.nonEtx, config.etx], config.treasury, deadline],
      });
    case 'swap-from-etx':
      return wallet.writeContract({
        chain: null,
        account,
        address: config.router,
        abi: abis.routerAbi,
        functionName: 'swapExactTokensForTokens',
        args: [a.etxIn, a.minNonEtxOut, [config.etx, a.nonEtx], config.treasury, deadline],
      });
    case 'add-liquidity-burn-lp':
      return wallet.writeContract({
        chain: null,
        account,
        address: config.router,
        abi: abis.routerAbi,
        functionName: 'addLiquidity',
        args: [
          config.etx,
          a.nonEtx,
          a.etxAmount,
          a.nonEtxAmount,
          a.minEtxIn,
          a.minNonEtxIn,
          DEAD_ADDRESS,
          deadline,
        ],
      });
    case 'distribute-to-staked-etx':
      return wallet.writeContract({
        chain: null,
        account,
        address: a.vault,
        abi: abis.stakedEtxAbi,
        functionName: 'distributeRewards',
        args: [a.amount],
      });
    case 'distribute-to-farms':
      // LPFarm ABI ships with PR #86; until then we never execute this branch
      // in dry-run and the live path asserts `farms === null`.
      throw new Error(
        `distribute-to-farms reached executeAction but LPFarm ABI not yet wired; ` +
          `unset HARVEST_FARMS_ADDRESS or wait for PR #86`,
      );
    case 'retain-in-treasury':
      // No-op on chain; the ETX is already in the treasury wallet.
      return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }
}

export interface RunHarvestDeps {
  /** Override for tests / dry-runs. */
  publicClient?: PublicClient;
  /** Override for tests. When unset, a wallet is created from config.privateKey. */
  walletClient?: WalletClient;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export async function runHarvest(
  config: HarvestConfig,
  deps: RunHarvestDeps = {},
): Promise<HarvestRunResult> {
  const log = deps.log ?? console;
  const client =
    deps.publicClient ??
    createPublicClient({
      transport: http(config.rpcUrl),
    });

  // 1. Snapshot both pools. If both are missing / treasury holds zero LP
  //    on both, the plan will be empty.
  log.info(`[harvest] reading treasury LP on pools owner=${config.treasury}`);
  const pairs: PairSnapshot[] = [];
  const snapEti = await snapshotPair(
    client,
    config.factory,
    config.etx,
    config.eti,
    'ETI/ETX',
    config.treasury,
  );
  if (snapEti) pairs.push(snapEti);
  const snapWegaz = await snapshotPair(
    client,
    config.factory,
    config.etx,
    config.wegaz,
    'WEGAZ/ETX',
    config.treasury,
  );
  if (snapWegaz) pairs.push(snapWegaz);

  const mode: 'delegation' | 'legacy' = config.harvester ? 'delegation' : 'legacy';

  if (pairs.length === 0) {
    log.info('[harvest] no canonical pools exist yet; skipping');
    return {
      skipped: true,
      dryRun: config.dryRun,
      mode,
      plan: {
        actions: [],
        pools: [],
        expectedEtxHarvested: 0n,
        splits: { stakedEtx: 0n, farms: 0n, polBurn: 0n, treasury: 0n },
        polBurnByPool: [],
        skipReason: 'no canonical pools exist yet',
      },
      submittedTxHashes: [],
    };
  }

  // 2. Build plan.
  const plan = buildHarvestPlan(config, pairs);
  const delegation = config.harvester ? buildDelegationCall(config, pairs, plan) : undefined;

  logPlan(plan, config, log);
  if (delegation) logDelegation(delegation, config, log);

  if (plan.actions.length === 0) {
    return {
      skipped: true,
      dryRun: config.dryRun,
      mode,
      plan,
      delegation,
      submittedTxHashes: [],
    };
  }

  if (config.dryRun) {
    log.info('[harvest] DRY-RUN: not submitting any transactions');
    return {
      skipped: false,
      dryRun: true,
      mode,
      plan,
      delegation,
      submittedTxHashes: [],
    };
  }

  // 3. Live execution. Requires a private key; the caller should have
  //    already loaded HARVEST_PRIVATE_KEY into config.
  if (!config.privateKey) {
    return {
      skipped: false,
      dryRun: false,
      mode,
      plan,
      delegation,
      submittedTxHashes: [],
      error: 'dryRun=false but HARVEST_PRIVATE_KEY is unset — refusing to submit',
    };
  }

  const account = privateKeyToAccount(config.privateKey);

  // Delegation mode: signer is the hot keeper EOA; never the treasury.
  if (config.harvester && delegation) {
    return runDelegation({
      config,
      plan,
      delegation,
      account,
      client,
      walletOverride: deps.walletClient,
      log,
    });
  }

  // Legacy path: signer must be the treasury.
  if (account.address.toLowerCase() !== config.treasury.toLowerCase()) {
    return {
      skipped: false,
      dryRun: false,
      mode,
      plan,
      submittedTxHashes: [],
      error:
        `HARVEST_PRIVATE_KEY derives ${account.address} but HARVEST_TREASURY_ADDRESS is ` +
        `${config.treasury} — the keeper must sign as the treasury to move its LP`,
    };
  }

  const wallet =
    deps.walletClient ??
    createWalletClient({
      account,
      transport: http(config.rpcUrl),
    });

  const submittedTxHashes: string[] = [];
  for (const a of plan.actions) {
    try {
      const hash = await executeAction(a, wallet, account.address, config);
      submittedTxHashes.push(hash);
      log.info(`[harvest] submitted ${a.kind}: ${hash}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`[harvest] failed at ${formatAction(a)}: ${msg}`);
      return {
        skipped: false,
        dryRun: false,
        mode,
        plan,
        submittedTxHashes,
        error: `failed at ${a.kind}: ${msg}`,
      };
    }
  }

  return { skipped: false, dryRun: false, mode, plan, submittedTxHashes };
}

interface RunDelegationArgs {
  config: HarvestConfig;
  plan: HarvestPlan;
  delegation: DelegationCall;
  account: ReturnType<typeof privateKeyToAccount>;
  client: PublicClient;
  walletOverride?: WalletClient;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

async function runDelegation(args: RunDelegationArgs): Promise<HarvestRunResult> {
  const { config, plan, delegation, account, client, walletOverride, log } = args;
  const mode = 'delegation' as const;
  const harvester = config.harvester!;

  // Verify the signer matches the on-chain keeper. If the treasury rotated
  // keepers between workflow runs we want to fail loud, not force a tx
  // that the contract will revert anyway.
  try {
    const onChainKeeper = (await client.readContract({
      address: harvester,
      abi: abis.treasuryHarvesterAbi,
      functionName: 'keeper',
    })) as Address;
    if (onChainKeeper.toLowerCase() !== account.address.toLowerCase()) {
      return {
        skipped: false,
        dryRun: false,
        mode,
        plan,
        delegation,
        submittedTxHashes: [],
        error:
          `HARVEST_PRIVATE_KEY derives ${account.address} but harvester.keeper() is ` +
          `${onChainKeeper} — rotate the keeper on the contract or the workflow secret`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      skipped: false,
      dryRun: false,
      mode,
      plan,
      delegation,
      submittedTxHashes: [],
      error: `failed to read harvester.keeper() at ${harvester}: ${msg}`,
    };
  }

  const wallet =
    walletOverride ??
    createWalletClient({
      account,
      transport: http(config.rpcUrl),
    });

  try {
    const hash = await wallet.writeContract({
      chain: null,
      account: account.address,
      address: harvester,
      abi: abis.treasuryHarvesterAbi,
      functionName: 'harvest',
      args: [
        delegation.pools.map((p) => ({
          pair: p.pair,
          nonEtx: p.nonEtx,
          lpToBurn: p.lpToBurn,
          minEtxFromBurn: p.minEtxFromBurn,
          minNonEtxFromBurn: p.minNonEtxFromBurn,
          minEtxFromSwap: p.minEtxFromSwap,
          polEtxForSwap: p.polEtxForSwap,
          polEtxForPair: p.polEtxForPair,
          minNonEtxFromPolSwap: p.minNonEtxFromPolSwap,
        })),
      ],
    });
    log.info(`[harvest] submitted harvester.harvest(): ${hash}`);
    return {
      skipped: false,
      dryRun: false,
      mode,
      plan,
      delegation,
      submittedTxHashes: [hash],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`[harvest] harvester.harvest() failed: ${msg}`);
    return {
      skipped: false,
      dryRun: false,
      mode,
      plan,
      delegation,
      submittedTxHashes: [],
      error: `harvester.harvest() failed: ${msg}`,
    };
  }
}

function logDelegation(
  delegation: DelegationCall,
  config: HarvestConfig,
  log: Pick<Console, 'info' | 'warn' | 'error'>,
): void {
  log.info(`[harvest] delegation: harvester=${config.harvester}`);
  log.info(`  totalPolAssigned=${delegation.totalPolAssigned}`);
  for (const p of delegation.pools) {
    log.info(
      `  pool pair=${p.pair} lpToBurn=${p.lpToBurn} ` +
        `minEtxFromBurn=${p.minEtxFromBurn} minNonEtxFromBurn=${p.minNonEtxFromBurn} ` +
        `minEtxFromSwap=${p.minEtxFromSwap} ` +
        `polEtxForSwap=${p.polEtxForSwap} polEtxForPair=${p.polEtxForPair} ` +
        `minNonEtxFromPolSwap=${p.minNonEtxFromPolSwap}`,
    );
  }
}

function logPlan(
  plan: HarvestPlan,
  config: HarvestConfig,
  log: Pick<Console, 'info' | 'warn' | 'error'>,
): void {
  log.info('[harvest] plan:');
  log.info(`  split: ${config.split.stakedEtxBps}/${config.split.farmsBps}/${config.split.polBurnBps}/${config.split.treasuryBps} bps (stETX/farms/POL/treasury)`);
  log.info(`  burn-per-run: ${config.burnBpsPerRun} bps per pool`);
  log.info(`  slippage cap: ${config.maxSlippageBps} bps`);
  log.info(`  POL weighting: ${config.polWeighting}`);
  for (const p of plan.pools) {
    log.info(
      `  pool ${p.label} pair=${p.pair} lpToBurn=${p.lpToBurn} ` +
        `expectedEtxFromBurn=${p.expectedEtxFromBurn} expectedNonEtxFromBurn=${p.expectedNonEtxFromBurn} ` +
        `expectedEtxFromSwap=${p.expectedEtxFromSwap}`,
    );
  }
  log.info(`  expectedEtxHarvested=${plan.expectedEtxHarvested}`);
  log.info(
    `  splits: stETX=${plan.splits.stakedEtx} farms=${plan.splits.farms} ` +
      `polBurn=${plan.splits.polBurn} treasury=${plan.splits.treasury}`,
  );
  for (const b of plan.polBurnByPool) {
    log.info(`  pol-burn ${b.label} etx=${b.etxForPool}`);
  }
  if (plan.skipReason) {
    log.info(`  skipReason: ${plan.skipReason}`);
  }
  log.info('[harvest] actions:');
  for (const a of plan.actions) {
    log.info(`  - ${formatAction(a)}`);
  }
}
