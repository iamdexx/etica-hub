/**
 * wRES local two-chain E2E harness.
 *
 * Proves the full keeper loop end-to-end against a LOCAL anvil (Etica/EVM) and a
 * LOCAL java-tron node (TRON) — no Nile, no mainnet, no external RPC. It deploys
 * every contract, wires the roles, seeds the reserve, locks a RES NFT, then runs
 * the REAL keeper (`createKeeper` + `runTick`, non-dry-run) tick by tick and
 * asserts each on-chain effect:
 *
 *   tick 1  entry   Locked -> mintTwin -> frontUpgrade (reserve-funded freeze)
 *   (inject energy-sale revenue into the twin pool)
 *   tick 2  payout  claimForPayout -> 1% reserve topUp -> mint eTRX -> swap to ETX
 *   (requestUnlock + fast-forward past the challenge window)
 *   tick 3  exit    permissionless executeUnlock -> RES returns to its locker
 *
 * Exit code 0 = every assertion held; 1 = something broke.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { Address } from 'viem';

import * as art from './harness/artifacts.js';
import { Evm } from './harness/evm.js';
import { Tron, toBigInt } from './harness/tron.js';
import {
  ETICA_CHAIN_ID,
  ETICA_RPC_URL,
  EVM_HOLDER_ADDR,
  EVM_KEEPER_PK,
  INITIAL_FRONT_TRX,
  MAX_FRONT_PER_EPOCH_TRX,
  MAX_SLIPPAGE_BPS,
  MIN_PAYOUT_TRX,
  RESERVE_SEED_TRX,
  RESERVE_TOPUP_BPS,
  REVENUE_TRX,
  TRON_KEEPER_PK,
  TRON_RECIPIENT_PK,
  TRON_RPC_URL,
  trxToSun,
} from './harness/config.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── Derived SUN amounts + expectations ────────────────────────────────────
const INITIAL_FRONT_SUN = trxToSun(INITIAL_FRONT_TRX); // 100 TRX
const MAX_FRONT_SUN = trxToSun(MAX_FRONT_PER_EPOCH_TRX); // 1000 TRX
const RESERVE_SEED_SUN = trxToSun(RESERVE_SEED_TRX); // 200 TRX
const REVENUE_SUN = trxToSun(REVENUE_TRX); // 50 TRX
const TOPUP_SUN = (REVENUE_SUN * BigInt(RESERVE_TOPUP_BPS)) / 10_000n; // 1% = 0.5 TRX
const PAYOUT_SUN = REVENUE_SUN - TOPUP_SUN; // 49.5 TRX
const EXPECTED_ETX_WEI = PAYOUT_SUN * 1_000_000_000_000n; // 1 SUN -> 1e12 wei eTRX, 1:1 -> ETX
const RESERVE_AFTER_FRONT_SUN = RESERVE_SEED_SUN - INITIAL_FRONT_SUN; // 100 TRX
const RESERVE_AFTER_TOPUP_SUN = RESERVE_AFTER_FRONT_SUN + TOPUP_SUN; // 100.5 TRX
const ROUTER_ETX_FLOAT = 1_000_000n * 10n ** 18n; // plenty to pay swaps
const RES_TOKEN_ID = 1n;
const CHALLENGE_WINDOW_S = 48 * 60 * 60; // RESLockVault default

// ── Tiny assertion + logging helpers ──────────────────────────────────────
let passes = 0;
function ok(label: string): void {
  passes += 1;
  console.log(`  \u2714 ${label}`);
}
function eq(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${label}\n    expected ${expected}\n    actual   ${actual}`);
  }
  ok(`${label} = ${actual}`);
}
function eqStr(label: string, actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`ASSERT FAILED: ${label}\n    expected ${expected}\n    actual   ${actual}`);
  }
  ok(`${label} = ${actual}`);
}
function isTrue(label: string, actual: boolean): void {
  if (!actual) throw new Error(`ASSERT FAILED: ${label} (expected true)`);
  ok(label);
}
function step(n: number | string, title: string): void {
  console.log(`\n\u2501\u2501 ${n}. ${title} \u2501\u2501`);
}

/**
 * Wait for N java-tron blocks to pass.  The keeper's tron adapter broadcasts
 * without waiting for confirmation, so we must let the chain settle before
 * asserting on-chain state after a real tick.
 */
async function waitTronBlocks(tron: Tron, n: number): Promise<void> {
  const start =
    (await tron.tronWeb.trx.getCurrentBlock()).block_header?.raw_data?.number ?? 0;
  for (let i = 0; i < n * 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const cur =
      (await tron.tronWeb.trx.getCurrentBlock()).block_header?.raw_data?.number ?? 0;
    if (cur >= start + n) return;
  }
  console.log('  (tron block wait timed out — continuing anyway)');
}

async function main(): Promise<void> {
  console.log('wRES local two-chain E2E harness');
  console.log(`  Etica (anvil): ${ETICA_RPC_URL}  chainId=${ETICA_CHAIN_ID}`);
  console.log(`  TRON  (java-tron): ${TRON_RPC_URL}`);

  const evm = new Evm();
  const tron = new Tron();

  // ── 0. Connectivity ─────────────────────────────────────────────────────
  step(0, 'Connectivity');
  const head = await evm.publicClient.getBlockNumber();
  ok(`anvil reachable (head block ${head})`);
  const tronBlock = await tron.tronWeb.trx.getCurrentBlock();
  ok(`java-tron reachable (block ${tronBlock.block_header?.raw_data?.number ?? '?'})`);
  console.log(`  EVM keeper/locker: ${evm.account.address}`);
  console.log(`  TRON keeper:       ${tron.ownerBase58}`);

  // ── 1. Deploy EVM (Etica) contracts ──────────────────────────────────────
  step(1, 'Deploy Etica (EVM) contracts to anvil');
  const resNft = await evm.deploy(art.MockRESNFT());
  console.log(`  MockRESNFT     ${resNft}`);
  const etx = await evm.deploy(art.MockETX());
  console.log(`  MockETX        ${etx}`);
  const router = await evm.deploy(art.MockDexRouter());
  console.log(`  MockDexRouter  ${router}`);
  const etrx = await evm.deploy(art.ETRX(), [evm.account.address]);
  console.log(`  ETRX           ${etrx}`);
  const vault = await evm.deploy(art.RESLockVault(), [resNft, evm.account.address, evm.account.address]);
  console.log(`  RESLockVault   ${vault}`);

  // Fund the router with ETX so it can pay swaps out.
  await evm.write(etx, art.MockETX().abi, 'mint', [router, ROUTER_ETX_FLOAT]);
  ok(`router funded with ${ROUTER_ETX_FLOAT} ETX`);

  // ── 2. Deploy TRON contracts + wire + seed ───────────────────────────────
  step(2, 'Deploy TRON contracts to java-tron, wire roles, seed reserve');
  const reactor = await tron.deploy('MockCoreReactor', art.MockCoreReactor());
  console.log(`  MockCoreReactor  ${reactor}`);
  const miner = await tron.deploy('WrappedRESMiner', art.WrappedRESMiner(), [tron.toHex(reactor)]);
  console.log(`  WrappedRESMiner  ${miner}`);
  const reserve = await tron.deploy('TrxReserve', art.TrxReserve(), [
    tron.toHex(miner),
    MAX_FRONT_SUN.toString(),
  ]);
  console.log(`  TrxReserve       ${reserve}`);

  const minerAbi = art.WrappedRESMiner().abi as readonly unknown[];
  const reserveAbi = art.TrxReserve().abi as readonly unknown[];
  const reactorAbi = art.MockCoreReactor().abi as readonly unknown[];

  await tron.send(minerAbi, miner, 'setReserve', [tron.toHex(reserve)]);
  ok('miner.setReserve(reserve)');
  await tron.send(reserveAbi, reserve, 'topUp', [], { callValue: Number(RESERVE_SEED_SUN) });
  eq('reserve balance seeded', await tron.balanceSun(reserve), RESERVE_SEED_SUN);

  // ── 3. Mint + lock the RES NFT on Etica ──────────────────────────────────
  step(3, 'Mint + lock a RES NFT (the entry trigger)');
  const tronRecipientBase58 = tron.addressOf(TRON_RECIPIENT_PK);
  const tronRecipientEvm = tron.toEvm(tronRecipientBase58);
  const payoutWallet = EVM_HOLDER_ADDR as Address;
  await evm.write(resNft, art.MockRESNFT().abi, 'mint', [evm.account.address, RES_TOKEN_ID]);
  await evm.write(resNft, art.MockRESNFT().abi, 'approve', [vault, RES_TOKEN_ID]);
  await evm.write(vault, art.RESLockVault().abi, 'lock', [RES_TOKEN_ID, payoutWallet, tronRecipientEvm]);
  ok(`locked RES #${RES_TOKEN_ID}  payout=${payoutWallet}  tronRecipient=${tronRecipientBase58}`);

  // ── 4. Write + load the keeper .env.local ────────────────────────────────
  step(4, 'Write keeper .env.local and load real config');
  const envPath = resolve(here, '.env.local');
  const envBody = [
    '# Generated by run-harness.ts — local two-chain harness. Throwaway dev keys.',
    `WRES_ETICA_RPC_URL=${ETICA_RPC_URL}`,
    `WRES_ETICA_CHAIN_ID=${ETICA_CHAIN_ID}`,
    `WRES_RES_LOCK_VAULT_ADDRESS=${vault}`,
    `WRES_ETRX_ADDRESS=${etrx}`,
    `WRES_ETX_ADDRESS=${etx}`,
    `WRES_DEX_ROUTER_ADDRESS=${router}`,
    `WRES_TRON_RPC_URL=${TRON_RPC_URL}`,
    `WRES_WRAPPED_RES_MINER_ADDRESS=${tron.toHex(miner)}`,
    `WRES_TRX_RESERVE_ADDRESS=${tron.toHex(reserve)}`,
    `WRES_KEEPER_ETICA_PRIVATE_KEY=${EVM_KEEPER_PK}`,
    `WRES_KEEPER_TRON_PRIVATE_KEY=${TRON_KEEPER_PK}`,
    `WRES_INITIAL_FRONT_TRX=${INITIAL_FRONT_TRX}`,
    `WRES_MIN_PAYOUT_TRX=${MIN_PAYOUT_TRX}`,
    `WRES_RESERVE_TOPUP_BPS=${RESERVE_TOPUP_BPS}`,
    `WRES_MAX_SLIPPAGE_BPS=${MAX_SLIPPAGE_BPS}`,
    'WRES_SCAN_LOOKBACK_BLOCKS=1000000',
    'WRES_TRON_FEE_LIMIT_SUN=1000000000',
    '',
  ].join('\n');
  writeFileSync(envPath, envBody);
  loadDotenv({ path: envPath, override: true });
  ok(`wrote + loaded ${envPath}`);

  // Import the REAL keeper after env is populated.
  const { loadConfig } = await import('../src/config.js');
  const { createKeeper, runTick } = await import('../src/keeper.js');

  const runReal = async (label: string) => {
    process.env.WRES_DRY_RUN = 'false';
    console.log(`\n  >>> runTick (REAL): ${label}`);
    return runTick(createKeeper(loadConfig()));
  };

  // ── 5. Dry-run tick (reads only, no broadcast) ───────────────────────────
  step(5, 'Dry-run tick — validate reads, broadcast nothing');
  process.env.WRES_DRY_RUN = 'true';
  const dry = createKeeper(loadConfig());
  const dryReport = await runTick(dry);
  eq('dry-run detected entry (minted)', BigInt(dryReport.minted), 1n);
  eq('dry-run twins on chain still 0', toBigInt(await tron.call(minerAbi, miner, 'totalSupply')), 0n);

  // ── 6. Real tick #1 — entry: mintTwin + frontUpgrade ─────────────────────
  step(6, 'Real tick #1 — entry (mintTwin + reserve-funded frontUpgrade)');
  const r1 = await runReal('entry');
  eq('report.minted', BigInt(r1.minted), 1n);
  eq('report.fronted', BigInt(r1.fronted), 1n);
  await waitTronBlocks(tron, 2);
  eq('miner totalSupply', toBigInt(await tron.call(minerAbi, miner, 'totalSupply')), 1n);
  const m1 = await tron.call<unknown[]>(minerAbi, miner, 'miners', [1n]);
  eq('twin frozenTrx', toBigInt(m1[2]), INITIAL_FRONT_SUN);
  eq('CoreReactor totalFrozen', toBigInt(await tron.call(reactorAbi, reactor, 'totalFrozen')), INITIAL_FRONT_SUN);
  eq('reserve balance after front', await tron.balanceSun(reserve), RESERVE_AFTER_FRONT_SUN);

  // ── 7. Inject energy-sale revenue into the twin pool ─────────────────────
  step(7, 'Inject energy-sale revenue (distributor -> twin pool)');
  await tron.send(minerAbi, miner, 'receiveRevenue', [], { callValue: Number(REVENUE_SUN) });
  eq('twin pendingReward', toBigInt(await tron.call(minerAbi, miner, 'pendingReward', [1n])), REVENUE_SUN);

  // ── 8. Real tick #2 — payout: claim -> 1% topUp -> eTRX -> swap to ETX ────
  step(8, 'Real tick #2 — payout (claim, 1% topUp, eTRX->ETX to holder)');
  const r2 = await runReal('payout');
  eq('report.paid', BigInt(r2.paid), 1n);
  await waitTronBlocks(tron, 2);
  eq('reserve balance after topUp', await tron.balanceSun(reserve), RESERVE_AFTER_TOPUP_SUN);
  eq('twin pendingReward cleared', toBigInt(await tron.call(minerAbi, miner, 'pendingReward', [1n])), 0n);
  const etxBal = await evm.read<bigint>(etx, art.MockETX().abi, 'balanceOf', [payoutWallet]);
  eq('holder ETX balance (99% leg)', etxBal, EXPECTED_ETX_WEI);

  // ── 9. Request unlock + fast-forward past the challenge window ────────────
  step(9, 'Request unlock + advance past the 48h challenge window');
  await evm.write(vault, art.RESLockVault().abi, 'requestUnlock', [RES_TOKEN_ID]);
  ok('requestUnlock submitted');
  await evm.increaseTime(CHALLENGE_WINDOW_S + 60);
  ok('advanced chain time > challengeWindow');

  // ── 10. Real tick #3 — exit: permissionless executeUnlock ────────────────
  step(10, 'Real tick #3 — exit (permissionless executeUnlock)');
  const r3 = await runReal('exit');
  eq('report.exited', BigInt(r3.exited), 1n);
  const nftOwner = await evm.read<string>(resNft, art.MockRESNFT().abi, 'ownerOf', [RES_TOKEN_ID]);
  eqStr('RES NFT returned to locker', nftOwner, evm.account.address);
  const lock = await evm.read<unknown[]>(vault, art.RESLockVault().abi, 'locks', [RES_TOKEN_ID]);
  isTrue('vault lock no longer active', lock[5] === false);

  console.log(`\n\u2705 ALL ASSERTIONS PASSED (${passes} checks)`);
  console.log('   Full loop proven locally: Locked -> mintTwin -> frontUpgrade ->');
  console.log('   revenue -> claim/1% topUp/99% eTRX->ETX -> unlock. No Nile, no mainnet.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n\u274C HARNESS FAILED: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
