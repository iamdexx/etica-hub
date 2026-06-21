/**
 * Local two-chain harness — fixed configuration.
 *
 * Everything here targets the LOCAL anvil (Etica/EVM) + LOCAL java-tron node
 * (TRON) brought up by `run.sh`. The keys are the well-known anvil / tronbox
 * development accounts — they are public, throwaway, and only ever used against
 * local chains. NEVER reuse them on a real network.
 */

/** Etica (EVM) — local anvil. */
export const ETICA_RPC_URL = process.env.WRES_E2E_ETICA_RPC ?? 'http://127.0.0.1:8545';
export const ETICA_CHAIN_ID = Number(process.env.WRES_E2E_ETICA_CHAIN_ID ?? 61803);

/** TRON — local java-tron FullNode (tronbox/tre). */
export const TRON_RPC_URL = process.env.WRES_E2E_TRON_RPC ?? 'http://127.0.0.1:9090';

/**
 * anvil account #0 — the keeper on Etica AND the RES locker (the "user").
 * Owns/keeps the vault, mints eTRX, signs the swap + executeUnlock.
 */
export const EVM_KEEPER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const EVM_KEEPER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** anvil account #1 — the holder's Etica payout wallet (receives ETX). */
export const EVM_HOLDER_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/**
 * tronbox/tre account #0 — the keeper on TRON. Deploys + owns/keeps the miner
 * and reserve, signs mintTwin / frontUpgrade / claimForPayout / topUp.
 * NOTE: stored 0x-prefixed because the keeper's config validates it as viem
 * `isHex`; the TRON adapter strips the prefix before handing it to tronweb.
 */
export const TRON_KEEPER_PK =
  '0x81fd9ad88348344be66c8ce60154562fd7e851b818981a78bd26f70384df1e62';
/** tronbox/tre account #1 — the TRON wallet that receives the minted twin. */
export const TRON_RECIPIENT_PK =
  '464ee6f98922c8f5ed091b11437d61343c05f65aa25df42e85e35419be654448';

// ── Economic scenario (decimal TRX; SUN = TRX * 1e6) ──────────────────────
/** TRX fronted into each new twin from the reserve. */
export const INITIAL_FRONT_TRX = 100;
/** Per-epoch drip cap on the reserve (must be >= INITIAL_FRONT_TRX). */
export const MAX_FRONT_PER_EPOCH_TRX = 1000;
/** TRX seeded into the reserve so it can front the first entry. */
export const RESERVE_SEED_TRX = 200;
/** Energy-sale revenue injected into the twin pool to drive a payout. */
export const REVENUE_TRX = 50;
/** Dust threshold below which a twin is not paid out. */
export const MIN_PAYOUT_TRX = 1;
/** Reserve top-up cut (basis points): 100 = 1%. */
export const RESERVE_TOPUP_BPS = 100;
/** Max swap slippage (basis points): 100 = 1%. */
export const MAX_SLIPPAGE_BPS = 100;

export const SUN_PER_TRX = 1_000_000n;
/** 1 TRX of claimed revenue mints 1e12 wei of eTRX (1 eTRX = 1 TRX, 18 dp). */
export const ETRX_WEI_PER_SUN = 1_000_000_000_000n;

export function trxToSun(trx: number): bigint {
  return BigInt(Math.round(trx * 1e6));
}
