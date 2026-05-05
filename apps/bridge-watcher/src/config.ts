/**
 * Environment loader for the bridge-watcher.
 *
 * The watcher operates across three chains:
 *   - Etica (source of truth — `BridgeVault` lives here, emits `Deposit`)
 *   - Ethereum (remote — `BridgeMinter` lives here, emits `ClaimSubmitted`)
 *   - BNB     (remote — `BridgeMinter` lives here, emits `ClaimSubmitted`)
 *
 * Each remote is configured independently. If a remote's RPC + minter
 * address are not both set, the script for that remote skips it cleanly
 * and exits 0 — the bridge isn't deployed yet, and CI must stay green
 * before the live deploy.
 */

import type { Address } from 'viem';

export interface RemoteChainConfig {
  /** Human label used in logs + Telegram alerts. */
  name: string;
  /** Hyperlane domain ID (Eth=1, BNB=56). */
  domain: number;
  /** EIP-155 chain ID. */
  chainId: number;
  /** RPC URL with eth_getLogs support. */
  rpcUrl: string;
  /** `BridgeMinter` deployment address on this chain. */
  minter: Address;
  /** Optional explorer URL prefix for tx links in alerts. */
  explorer?: string;
}

export interface EticaConfig {
  /** Etica RPC URL. */
  rpcUrl: string;
  /** EIP-155 chain ID — 61803 on Etica mainnet. */
  chainId: number;
  /** `BridgeVault` deployment address. */
  vault?: Address;
}

export interface WatcherConfig {
  /** Etica side — required for sanity checks even on heartbeat-only runs. */
  etica: EticaConfig;
  /** Remote chains the watcher is responsible for. */
  remotes: RemoteChainConfig[];
  /** Heartbeat-signing EOA private key (`heartbeatSigner` on each minter). */
  heartbeatPrivateKey?: `0x${string}`;
  /** Optional execute-call EOA private key (anyone can call `executeClaim`,
   *  but the watcher pays gas for the convenience flow). */
  executePrivateKey?: `0x${string}`;
  /** Telegram bot token + chat ID for alerts. Optional — skip if unset. */
  telegramBotToken?: string;
  telegramChatId?: string;
  /** How many blocks back to scan for events on each tick. */
  scanLookbackBlocks: number;
}

function readAddress(env: NodeJS.ProcessEnv, key: string): Address | undefined {
  const value = env[key]?.trim();
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`[bridge-watcher] ${key} is set but not a valid 0x-prefixed address`);
  }
  return value as Address;
}

function readPrivateKey(env: NodeJS.ProcessEnv, key: string): `0x${string}` | undefined {
  const value = env[key]?.trim();
  if (!value) return undefined;
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`[bridge-watcher] ${key} is set but not a valid 32-byte private key`);
  }
  return normalized as `0x${string}`;
}

function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`[bridge-watcher] ${key} is set but not a non-negative number: ${value}`);
  }
  return parsed;
}

function loadRemote(
  env: NodeJS.ProcessEnv,
  prefix: 'ETH' | 'BNB',
  defaults: { name: string; domain: number; chainId: number; rpcUrl: string; explorer: string },
): RemoteChainConfig | undefined {
  const minter = readAddress(env, `BRIDGE_MINTER_${prefix}_ADDRESS`);
  if (!minter) return undefined;
  return {
    name: defaults.name,
    domain: readNumber(env, `BRIDGE_${prefix}_DOMAIN`, defaults.domain),
    chainId: readNumber(env, `BRIDGE_${prefix}_CHAIN_ID`, defaults.chainId),
    rpcUrl: env[`BRIDGE_${prefix}_RPC_URL`]?.trim() || defaults.rpcUrl,
    minter,
    explorer: env[`BRIDGE_${prefix}_EXPLORER`]?.trim() || defaults.explorer,
  };
}

export function loadWatcherConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  const remotes: RemoteChainConfig[] = [];

  const eth = loadRemote(env, 'ETH', {
    name: 'Ethereum',
    domain: 1,
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io',
  });
  if (eth) remotes.push(eth);

  const bnb = loadRemote(env, 'BNB', {
    name: 'BNB Chain',
    domain: 56,
    chainId: 56,
    rpcUrl: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com',
  });
  if (bnb) remotes.push(bnb);

  return {
    etica: {
      rpcUrl: env.BRIDGE_ETICA_RPC_URL?.trim() || 'https://eticamainnet.eticascan.org',
      chainId: readNumber(env, 'BRIDGE_ETICA_CHAIN_ID', 61803),
      vault: readAddress(env, 'BRIDGE_VAULT_ADDRESS'),
    },
    remotes,
    heartbeatPrivateKey: readPrivateKey(env, 'BRIDGE_HEARTBEAT_PRIVATE_KEY'),
    executePrivateKey: readPrivateKey(env, 'BRIDGE_EXECUTE_PRIVATE_KEY'),
    telegramBotToken: env.BRIDGE_TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: env.BRIDGE_TELEGRAM_CHAT_ID?.trim() || undefined,
    scanLookbackBlocks: readNumber(env, 'BRIDGE_SCAN_LOOKBACK_BLOCKS', 5_000),
  };
}
