/**
 * Environment loader for the EticaSwap Direct watcher.
 *
 * Skip-clean: when the factory address is zero (venue not deployed) the
 * watcher logs and exits 0 so the cron stays green before launch.
 */

import { DEPLOYMENTS } from '@etica-hub/shared';
import type { Address } from 'viem';

export interface ExpectedSettings {
  feeTo?: Address;
  feeToSetter?: Address;
  guardian?: Address;
  metaPairDeployer?: Address;
  minStEtx?: string;
  baseFeeBps?: number;
  tiers?: { minStEtx: string; feeBps: number }[];
  /** Addresses that must be whitelisted (router, harvester, seeder). */
  whitelist?: Address[];
}

export interface WatcherConfig {
  rpcUrl: string;
  chainId: number;
  factory: Address;
  harvester?: Address;
  guardianPrivateKey?: `0x${string}`;
  /** Reported reserve ratio may drift from the hub cross price by this much. */
  reserveDriftBps: number;
  /** A swap whose input exceeds this share of the window's reserve is reported. */
  largeSwapBps: number;
  /** Max blocks to scan for Swap events per run. */
  scanLookbackBlocks: number;
  statePath: string;
  expectedPath: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

function readAddress(env: NodeJS.ProcessEnv, key: string): Address | undefined {
  const v = env[key]?.trim();
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${key} is not an address: ${v}`);
  return v as Address;
}

function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = env[key]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} is not a number: ${v}`);
  return n;
}

function readKey(env: NodeJS.ProcessEnv, key: string): `0x${string}` | undefined {
  const v = env[key]?.trim();
  if (!v) return undefined;
  const hex = v.startsWith('0x') ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${key} is not a 32-byte key`);
  return hex as `0x${string}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const chainId = readNumber(env, 'DIRECT_CHAIN_ID', 61803);
  const deployment = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS];
  return {
    rpcUrl: env.DIRECT_RPC_URL?.trim() || 'https://rpc2.etica-stats.org',
    chainId,
    factory: readAddress(env, 'DIRECT_FACTORY_ADDRESS') ?? deployment?.directFactory ?? ZERO,
    harvester:
      readAddress(env, 'DIRECT_HARVESTER_ADDRESS') ?? deployment?.directHarvesterAdapter ?? undefined,
    guardianPrivateKey: readKey(env, 'DIRECT_GUARDIAN_PRIVATE_KEY'),
    reserveDriftBps: readNumber(env, 'DIRECT_RESERVE_DRIFT_BPS', 100),
    largeSwapBps: readNumber(env, 'DIRECT_LARGE_SWAP_BPS', 500),
    scanLookbackBlocks: readNumber(env, 'DIRECT_SCAN_LOOKBACK_BLOCKS', 5000),
    statePath: env.DIRECT_STATE_PATH?.trim() || 'state/direct-watch.json',
    expectedPath: env.DIRECT_EXPECTED_PATH?.trim() || 'expected.json',
    telegramBotToken: env.DIRECT_TELEGRAM_BOT_TOKEN?.trim() || env.BRIDGE_TELEGRAM_BOT_TOKEN?.trim(),
    telegramChatId: env.DIRECT_TELEGRAM_CHAT_ID?.trim() || env.BRIDGE_TELEGRAM_CHAT_ID?.trim(),
  };
}

export function isZeroAddress(a: Address | undefined): boolean {
  return !a || a.toLowerCase() === ZERO;
}
