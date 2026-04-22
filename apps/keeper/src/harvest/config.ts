/**
 * Harvester configuration — loaded from environment variables.
 *
 * The harvester runs once per cadence (GitHub Actions cron), reads the
 * treasury's LP balances on the two canonical ETX pools (ETI/ETX and
 * WEGAZ/ETX), burns a configurable slice of each LP position to realize
 * the accrued protocol-fee LP + a thin slice of principal into underlying
 * tokens, swaps the non-ETX legs to ETX via the router, and splits the
 * harvested ETX across four sinks:
 *
 *   10% → stETX.distributeRewards(...)         — LST holders
 *   10% → LPFarm.distributeRewards(...)        — LP stakers (if deployed)
 *   40% → paired+addLiquidity per pool by      — permanent POL
 *         treasury-LP weight, LP to 0xdead
 *   40% → retained in treasury wallet          — ops runway
 *
 * All four slices are configurable. The 40% POL slice is split across the
 * two pools proportionally to the treasury's LP holdings on each pool
 * (default) — this compounds depth where the treasury is already
 * overweight.
 *
 * Units: "BPS" = basis points (1% = 100, 100% = 10000). All four slice
 * knobs must sum to 10000; the config loader enforces this.
 */

import 'dotenv/config';
import { isAddress, isHex, type Address, type Hex } from 'viem';

export interface HarvestSplit {
  /** Share routed to stETX.distributeRewards(), in BPS. */
  stakedEtxBps: number;
  /** Share routed to LPFarm.distributeRewards(), in BPS. */
  farmsBps: number;
  /** Share used to buy non-ETX legs + addLiquidity + burn LP, in BPS. */
  polBurnBps: number;
  /** Share retained in the treasury wallet, in BPS. */
  treasuryBps: number;
}

export type PolWeighting = 'treasury_lp' | 'equal';

export interface HarvestConfig {
  /** RPC endpoint for reads + tx submission. */
  rpcUrl: string;

  /** Chain ID. Etica mainnet = 61803. */
  chainId: number;

  /** Treasury EOA — holds the LP, receives the retained slice. */
  treasury: Address;

  /** Canonical ETX token. */
  etx: Address;

  /** ETI token (same address as eticaCore on Etica). */
  eti: Address;

  /** WEGAZ token. */
  wegaz: Address;

  /** EticaSwap V2 router. */
  router: Address;

  /** EticaSwap V2 factory. */
  factory: Address;

  /**
   * stETX ERC-4626 vault. When null/zero, the stETX slice is rerouted to
   * the treasury (logged as a fallback).
   */
  stakedEtx: Address | null;

  /**
   * LPFarm contract. When null/zero, the farms slice is rerouted to the
   * treasury (logged as a fallback). Farms ship in a later PR.
   */
  farms: Address | null;

  /** Four-way split, BPS must sum to 10000. */
  split: HarvestSplit;

  /**
   * Fraction of the treasury's LP on each pool to burn per run, in BPS.
   * Default: 100 bps (1%). Keep small — daily 1% converges to ~37% of LP
   * harvested over a year in the steady state.
   */
  burnBpsPerRun: number;

  /**
   * Maximum slippage tolerated on the non-ETX → ETX swap (and the ETX →
   * non-ETX swap on the POL branch), in BPS. Default: 300 (3%). If the
   * router's amountOut falls below (1 - slippage) × spot, we abort the
   * run and log.
   */
  maxSlippageBps: number;

  /** How to split the POL slice across the two pools. Default: 'treasury_lp'. */
  polWeighting: PolWeighting;

  /** Signer private key for on-chain txs. Required unless dryRun. */
  privateKey: Hex | null;

  /**
   * When true, the harvester reads chain state, produces a plan, logs what
   * it WOULD do, and exits without sending any transactions. Default:
   * true when no private key is set, false when a key is present (unless
   * explicitly overridden).
   */
  dryRun: boolean;
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || v.length === 0) throw new Error(`missing required env: ${name}`);
  return v;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return v && v.length > 0 ? v : null;
}

function optInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${v}`);
  }
  return n;
}

function reqAddress(env: NodeJS.ProcessEnv, name: string): Address {
  const v = req(env, name);
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return v as Address;
}

function optAddress(env: NodeJS.ProcessEnv, name: string): Address | null {
  const v = opt(env, name);
  if (!v) return null;
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  const lower = v.toLowerCase();
  if (lower === '0x0000000000000000000000000000000000000000') return null;
  return v as Address;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export function loadHarvestConfig(env: NodeJS.ProcessEnv = process.env): HarvestConfig {
  const split: HarvestSplit = {
    stakedEtxBps: optInt(env, 'HARVEST_STAKED_ETX_BPS', 1000),
    farmsBps: optInt(env, 'HARVEST_FARMS_BPS', 1000),
    polBurnBps: optInt(env, 'HARVEST_POL_BURN_BPS', 4000),
    treasuryBps: optInt(env, 'HARVEST_TREASURY_BPS', 4000),
  };
  const sum = split.stakedEtxBps + split.farmsBps + split.polBurnBps + split.treasuryBps;
  if (sum !== 10_000) {
    throw new Error(
      `HARVEST_*_BPS split must sum to 10000, got ${sum}: ` +
        `stakedEtx=${split.stakedEtxBps} farms=${split.farmsBps} ` +
        `polBurn=${split.polBurnBps} treasury=${split.treasuryBps}`,
    );
  }

  const burnBpsPerRun = optInt(env, 'HARVEST_BURN_BPS_PER_RUN', 100);
  if (burnBpsPerRun === 0 || burnBpsPerRun > 10_000) {
    throw new Error(`HARVEST_BURN_BPS_PER_RUN must be in [1, 10000], got ${burnBpsPerRun}`);
  }

  const maxSlippageBps = optInt(env, 'HARVEST_MAX_SLIPPAGE_BPS', 300);
  if (maxSlippageBps > 10_000) {
    throw new Error(`HARVEST_MAX_SLIPPAGE_BPS must be <= 10000, got ${maxSlippageBps}`);
  }

  const weightingRaw = opt(env, 'HARVEST_POL_WEIGHTING') ?? 'treasury_lp';
  if (weightingRaw !== 'treasury_lp' && weightingRaw !== 'equal') {
    throw new Error(`HARVEST_POL_WEIGHTING must be 'treasury_lp' or 'equal', got ${weightingRaw}`);
  }

  const pk = opt(env, 'HARVEST_PRIVATE_KEY');
  if (pk !== null && !isHex(pk)) {
    throw new Error('HARVEST_PRIVATE_KEY must be 0x-prefixed hex');
  }

  const dryRunRaw = opt(env, 'HARVEST_DRY_RUN');
  const dryRun = dryRunRaw === null ? pk === null : /^(1|true|yes)$/i.test(dryRunRaw);

  return {
    rpcUrl: req(env, 'HARVEST_RPC_URL'),
    chainId: optInt(env, 'HARVEST_CHAIN_ID', 61803),
    treasury: reqAddress(env, 'HARVEST_TREASURY_ADDRESS'),
    etx: reqAddress(env, 'HARVEST_ETX_ADDRESS'),
    eti: reqAddress(env, 'HARVEST_ETI_ADDRESS'),
    wegaz: reqAddress(env, 'HARVEST_WEGAZ_ADDRESS'),
    router: reqAddress(env, 'HARVEST_ROUTER_ADDRESS'),
    factory: reqAddress(env, 'HARVEST_FACTORY_ADDRESS'),
    stakedEtx: optAddress(env, 'HARVEST_STAKED_ETX_ADDRESS'),
    farms: optAddress(env, 'HARVEST_FARMS_ADDRESS'),
    split,
    burnBpsPerRun,
    maxSlippageBps,
    polWeighting: weightingRaw,
    privateKey: pk as Hex | null,
    dryRun,
  };
}

export const ZERO_ADDRESS: Address = ZERO as Address;
export const DEAD_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD' as Address;
