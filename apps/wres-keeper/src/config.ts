/**
 * wRES keeper configuration — loaded from environment variables.
 *
 * The keeper spans two chains: Etica (viem) for the RESLockVault + ETRX + DEX,
 * and TRON (tronweb) for the WrappedRESMiner + TrxReserve. Most fields are
 * optional so the keeper degrades gracefully: with no private keys it forces
 * DRY-RUN (reads + logs intended writes, never broadcasts), and any leg whose
 * contract address is unset is simply skipped.
 *
 * Numeric TRX policy fields are parsed as decimal TRX and stored as SUN
 * (`bigint`, 1 TRX = 1e6 SUN) so the loop never juggles units.
 */

import 'dotenv/config';
import { isAddress, isHex, type Address } from 'viem';
import { SUN_PER_TRX, type Hex } from './types.js';

export interface WresKeeperConfig {
  // ── Etica ──────────────────────────────────────────────────────────────
  eticaRpcUrl: string;
  eticaChainId: number;
  /** RESLockVault on Etica. When null, the entry watcher is disabled. */
  resLockVault: Address | null;
  /** ETRX (bridged TRX) on Etica. When null, the payout leg is disabled. */
  etrx: Address | null;
  /** ETX token on Etica. When null, the swap leg is disabled. */
  etx: Address | null;
  /** DEX router on Etica. When null, the swap leg is disabled. */
  dexRouter: Address | null;

  // ── TRON ───────────────────────────────────────────────────────────────
  tronRpcUrl: string;
  /** WrappedRESMiner on TRON (base58 T... or 0x41 hex). */
  wrappedResMiner: string | null;
  /** TrxReserve on TRON. When null, fronting is disabled. */
  trxReserve: string | null;
  /** Per-transaction fee ceiling for TRON sends, in SUN. */
  tronFeeLimitSun: number;

  // ── Signers ────────────────────────────────────────────────────────────
  keeperTronPrivateKey: Hex | null;
  keeperEticaPrivateKey: Hex | null;

  // ── Economic policy (SUN) ──────────────────────────────────────────────
  /** TRX (SUN) fronted into each new twin (0 = don't auto-front). */
  initialFrontSun: bigint;
  /** Minimum settled TRX (SUN) before paying a twin out. */
  minPayoutSun: bigint;
  /** Revenue slice retained in the reserve, in basis points (100 = 1%). */
  reserveTopUpBps: number;
  /** Revenue slice retained by the keeper for gas/energy, in basis points (100 = 1%). */
  keeperOpsBps: number;
  /** Max tolerated slippage on the eTRX->ETX swap, in basis points (100 = 1%). */
  maxSlippageBps: number;

  // ── Loop / scanning ────────────────────────────────────────────────────
  scanLookbackBlocks: number;
  pollIntervalMs: number;
  dryRun: boolean;

  // ── Alerts ─────────────────────────────────────────────────────────────
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return v && v.length > 0 ? v : null;
}

function optionalInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${v}`);
  }
  return n;
}

/** Parse a decimal TRX amount into SUN (bigint). Rejects negatives / garbage. */
function optionalTrxToSun(env: NodeJS.ProcessEnv, name: string, fallbackTrx: number): bigint {
  const raw = env[name];
  const value = raw && raw.length > 0 ? raw : String(fallbackTrx);
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a non-negative decimal TRX amount, got: ${value}`);
  }
  const [whole, frac = ''] = value.split('.');
  if (frac.length > 6) {
    throw new Error(`${name} has sub-SUN precision (>6 decimals): ${value}`);
  }
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole ?? '0') * SUN_PER_TRX + BigInt(fracPadded);
}

function optionalAddress(env: NodeJS.ProcessEnv, name: string): Address | null {
  const raw = optional(env, name);
  if (raw === null) return null;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid address: ${raw}`);
  if (raw === '0x0000000000000000000000000000000000000000') return null;
  return raw as Address;
}

/**
 * Loose TRON-address validation: base58 (T + 33 chars) or hex (41-prefixed,
 * 42 chars, optionally 0x). tronweb performs the authoritative check at use.
 */
function isTronAddress(value: string): boolean {
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return true;
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  return /^41[0-9a-fA-F]{40}$/.test(hex);
}

function optionalTronAddress(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = optional(env, name);
  if (raw === null) return null;
  if (!isTronAddress(raw)) throw new Error(`${name} is not a valid TRON address: ${raw}`);
  return raw;
}

function optionalHexKey(env: NodeJS.ProcessEnv, name: string): Hex | null {
  const raw = optional(env, name);
  if (raw === null) return null;
  if (!isHex(raw)) throw new Error(`${name} must be 0x-prefixed hex`);
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WresKeeperConfig {
  const tronKey = optionalHexKey(env, 'WRES_KEEPER_TRON_PRIVATE_KEY');
  const eticaKey = optionalHexKey(env, 'WRES_KEEPER_ETICA_PRIVATE_KEY');

  // Dry-run unless explicitly disabled; defaults to true when neither key is set.
  const dryRunRaw = optional(env, 'WRES_DRY_RUN');
  const dryRun =
    dryRunRaw === null ? tronKey === null && eticaKey === null : /^(1|true|yes)$/i.test(dryRunRaw);

  const reserveTopUpBps = optionalInt(env, 'WRES_RESERVE_TOPUP_BPS', 100);
  if (reserveTopUpBps > 10_000) {
    throw new Error(`WRES_RESERVE_TOPUP_BPS cannot exceed 10000 (100%), got: ${reserveTopUpBps}`);
  }

  const keeperOpsBps = optionalInt(env, 'WRES_KEEPER_OPS_BPS', 100);
  if (keeperOpsBps > 10_000) {
    throw new Error(`WRES_KEEPER_OPS_BPS cannot exceed 10000 (100%), got: ${keeperOpsBps}`);
  }

  if (reserveTopUpBps + keeperOpsBps > 10_000) {
    throw new Error(
      `WRES_RESERVE_TOPUP_BPS (${reserveTopUpBps}) + WRES_KEEPER_OPS_BPS (${keeperOpsBps}) exceed 10000 (100%)`,
    );
  }

  const maxSlippageBps = optionalInt(env, 'WRES_MAX_SLIPPAGE_BPS', 100);
  if (maxSlippageBps > 10_000) {
    throw new Error(`WRES_MAX_SLIPPAGE_BPS cannot exceed 10000 (100%), got: ${maxSlippageBps}`);
  }

  // tronweb's `feeLimit` send option is denominated in SUN; default 150 TRX.
  const tronFeeLimitSun = optionalInt(env, 'WRES_TRON_FEE_LIMIT_SUN', 150_000_000);

  return {
    eticaRpcUrl: optional(env, 'WRES_ETICA_RPC_URL') ?? 'https://rpc2.etica-stats.org',
    eticaChainId: optionalInt(env, 'WRES_ETICA_CHAIN_ID', 61803),
    resLockVault: optionalAddress(env, 'WRES_RES_LOCK_VAULT_ADDRESS'),
    etrx: optionalAddress(env, 'WRES_ETRX_ADDRESS'),
    etx: optionalAddress(env, 'WRES_ETX_ADDRESS'),
    dexRouter: optionalAddress(env, 'WRES_DEX_ROUTER_ADDRESS'),

    tronRpcUrl: optional(env, 'WRES_TRON_RPC_URL') ?? 'https://api.trongrid.io',
    wrappedResMiner: optionalTronAddress(env, 'WRES_WRAPPED_RES_MINER_ADDRESS'),
    trxReserve: optionalTronAddress(env, 'WRES_TRX_RESERVE_ADDRESS'),
    tronFeeLimitSun,

    keeperTronPrivateKey: tronKey,
    keeperEticaPrivateKey: eticaKey,

    initialFrontSun: optionalTrxToSun(env, 'WRES_INITIAL_FRONT_TRX', 0),
    minPayoutSun: optionalTrxToSun(env, 'WRES_MIN_PAYOUT_TRX', 1),
    reserveTopUpBps,
    keeperOpsBps,
    maxSlippageBps,

    scanLookbackBlocks: optionalInt(env, 'WRES_SCAN_LOOKBACK_BLOCKS', 5_000),
    // Clamp to >=1ms so a misconfigured 0 doesn't spin the event loop.
    pollIntervalMs: Math.max(optionalInt(env, 'WRES_POLL_INTERVAL_MS', 60_000), 1),
    dryRun,

    telegramBotToken: optional(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: optional(env, 'TELEGRAM_CHAT_ID'),
  };
}
