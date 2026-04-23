/**
 * Runtime configuration for the Telegram buy bot cron (`/api/cron/buybot`).
 *
 * The bot runs once per minute on Vercel's scheduler, scans the on-chain
 * delta of `Swap` events since the last cron run, and posts a formatted
 * message to Telegram for every swap crossing `minUsdToPost`.
 *
 * All knobs are env-driven so deploying to a different chain or channel
 * never requires a code change.
 */

import type { Address } from 'viem';
import { getAddress, isAddress } from 'viem';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES } from '@etica-hub/shared';

const MAINNET_CHAIN_ID = 61803 as const;

export interface BuyBotConfig {
  enabled: boolean;
  chainId: number;
  rpcUrl: string;
  factory: Address;
  etx: Address;
  eti: Address;
  wegaz: Address;
  telegramBotToken: string;
  telegramChatId: string;
  /** Base URL the user-facing site is deployed at, used for explorer links. */
  explorerBaseUrl: string;
  /** Skip posting swaps whose USD notional is below this threshold. */
  minUsdToPost: number;
  /** Cap the number of blocks scanned in a single cron run. */
  maxBlocksPerRun: number;
  /** NonKYC REST base URL for ETI/EGAZ USD spot quotes. */
  nonkycApiUrl: string;
  /** Upstash Redis REST endpoint for storing `lastScannedBlock`. */
  kvRestUrl: string | null;
  kvRestToken: string | null;
  /**
   * TCP Redis connection string (`redis://` / `rediss://`). Used when the
   * HTTP REST variables are not set — covers Vercel Marketplace Redis
   * (Redis Cloud), self-hosted Redis, and ElastiCache.
   */
  redisUrl: string | null;
  /**
   * Namespace for the KV keys this bot owns, so different deployments sharing
   * a KV instance don't stomp on each other.
   */
  kvNamespace: string;
}

function optionalAddr(env: NodeJS.ProcessEnv, name: string, fallback: Address): Address {
  const v = env[name];
  if (!v) return fallback;
  if (!isAddress(v, { strict: false })) {
    throw new Error(`${name} is not a valid EVM address: ${v}`);
  }
  return getAddress(v);
}

/**
 * Parse buybot config from env vars. Returns `null` (with `enabled=false`)
 * when required secrets are missing — lets the cron route no-op safely in
 * preview deploys that don't have Telegram credentials.
 */
export function loadBuyBotConfig(env: NodeJS.ProcessEnv = process.env): BuyBotConfig {
  const token = env.BUYBOT_TELEGRAM_BOT_TOKEN ?? '';
  const chat = env.BUYBOT_TELEGRAM_CHAT_ID ?? '';
  const rpc = env.BUYBOT_RPC_URL ?? env.ETICA_MAINNET_RPC_URL ?? '';

  const chainId = Number(env.BUYBOT_CHAIN_ID ?? MAINNET_CHAIN_ID);
  const deployments =
    DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS] ?? DEPLOYMENTS[MAINNET_CHAIN_ID];
  const externals =
    EXTERNAL_ADDRESSES[chainId as keyof typeof EXTERNAL_ADDRESSES] ??
    EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];

  const minUsd = Number(env.BUYBOT_MIN_USD_TO_POST ?? '1');
  const maxBlocks = Number(env.BUYBOT_MAX_BLOCKS_PER_RUN ?? '2000');

  // When credentials or RPC are absent the cron runs in "disabled" mode:
  // returns a no-op result and never attempts network calls.
  const enabled = token.length > 0 && chat.length > 0 && rpc.length > 0;

  return {
    enabled,
    chainId,
    rpcUrl: rpc,
    factory: optionalAddr(env, 'BUYBOT_FACTORY', deployments.swapFactory),
    etx: optionalAddr(env, 'BUYBOT_ETX', deployments.etx),
    eti: optionalAddr(env, 'BUYBOT_ETI', externals.eti),
    wegaz: optionalAddr(env, 'BUYBOT_WEGAZ', deployments.wegaz),
    telegramBotToken: token,
    telegramChatId: chat,
    explorerBaseUrl: env.BUYBOT_EXPLORER_BASE_URL ?? 'https://eticahub.com',
    minUsdToPost: Number.isFinite(minUsd) && minUsd >= 0 ? minUsd : 1,
    maxBlocksPerRun: Number.isFinite(maxBlocks) && maxBlocks > 0 ? Math.floor(maxBlocks) : 2000,
    nonkycApiUrl: env.BUYBOT_NONKYC_API_URL ?? 'https://api.nonkyc.io',
    kvRestUrl: env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL ?? null,
    kvRestToken: env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN ?? null,
    redisUrl: env.REDIS_URL ?? null,
    kvNamespace: env.BUYBOT_KV_NAMESPACE ?? 'buybot:v1',
  };
}
