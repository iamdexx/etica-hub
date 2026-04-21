/**
 * Keeper configuration — loaded from environment variables.
 *
 * This is a reference keeper. It polls the order-book API for open orders,
 * filters out expired / already-cancelled ones, and (in a future PR) simulates
 * + submits fills via the UniswapX DutchOrderReactor.
 *
 * v1 scope: polling loop + filtering only. Fill submission is a stub.
 */

import 'dotenv/config';
import { isAddress, isHex, type Address, type Hex } from 'viem';

export interface KeeperConfig {
  /**
   * Base URL of the order-book API (e.g. http://localhost:3100). Optional
   * when `registryAddress` is set — the keeper reads directly from on-chain
   * `OrderPosted` logs in that mode.
   */
  orderbookUrl: string | null;

  /**
   * OrderRegistry contract address. When set, the keeper ignores
   * `orderbookUrl` and sources orders from on-chain events instead.
   */
  registryAddress: Address | null;

  /** Optional auth token sent as X-Keeper-Auth on mark-filled POSTs. */
  keeperAuthToken: string | null;

  /** RPC endpoint for reads + (eventual) fill submission. */
  rpcUrl: string;

  /** Chain ID. Etica mainnet = 61803. */
  chainId: number;

  /** DutchOrderReactor address we're keeping for. */
  reactor: Address;

  /** Signer private key for fill-submission txs. OPTIONAL for v1 (stub). */
  keeperPrivateKey: Hex | null;

  /** Polling cadence in milliseconds. */
  pollIntervalMs: number;

  /** Max orders fetched per poll (avoids DB hot-pulls). */
  pollBatchSize: number;

  /** Grace window before deadline where we stop bothering to simulate. */
  deadlineGraceSeconds: number;

  /**
   * When true, the keeper only logs "would attempt fill" lines and never
   * submits transactions, even if `keeperPrivateKey` is set. Used by the
   * GitHub Actions cron workflow so we can run the keeper publicly without
   * funding a hot wallet.
   */
  dryRun: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`missing required env: ${name}`);
  return v;
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.length > 0 ? v : null;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${v}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  // Apply overrides for testability.
  const snapshot = process.env;
  process.env = env;
  try {
    const reactor = required('KEEPER_REACTOR_ADDRESS');
    if (!isAddress(reactor)) throw new Error(`KEEPER_REACTOR_ADDRESS is not an address: ${reactor}`);

    const registryRaw = optional('KEEPER_REGISTRY_ADDRESS');
    if (registryRaw !== null && !isAddress(registryRaw)) {
      throw new Error(`KEEPER_REGISTRY_ADDRESS is not an address: ${registryRaw}`);
    }
    const registryAddress =
      registryRaw !== null && registryRaw !== '0x0000000000000000000000000000000000000000'
        ? (registryRaw as Address)
        : null;

    const orderbookRaw = optional('ORDERBOOK_URL');
    const orderbookUrl = orderbookRaw !== null ? orderbookRaw.replace(/\/+$/, '') : null;

    if (!registryAddress && !orderbookUrl) {
      throw new Error(
        'either KEEPER_REGISTRY_ADDRESS or ORDERBOOK_URL must be set — keeper has no source of orders',
      );
    }

    const pk = optional('KEEPER_PRIVATE_KEY');
    if (pk !== null && !isHex(pk)) {
      throw new Error('KEEPER_PRIVATE_KEY must be 0x-prefixed hex');
    }

    const dryRunRaw = optional('KEEPER_DRY_RUN');
    const dryRun = dryRunRaw === null ? pk === null : /^(1|true|yes)$/i.test(dryRunRaw);

    return {
      orderbookUrl,
      registryAddress,
      keeperAuthToken: optional('KEEPER_AUTH_TOKEN'),
      rpcUrl: required('KEEPER_RPC_URL'),
      chainId: optionalInt('KEEPER_CHAIN_ID', 61803),
      reactor: reactor as Address,
      keeperPrivateKey: pk as Hex | null,
      // Clamp to >=1ms so a misconfigured 0 doesn't spin the event loop.
      pollIntervalMs: Math.max(optionalInt('KEEPER_POLL_INTERVAL_MS', 5_000), 1),
      pollBatchSize: optionalInt('KEEPER_POLL_BATCH_SIZE', 50),
      deadlineGraceSeconds: optionalInt('KEEPER_DEADLINE_GRACE_SECONDS', 30),
      dryRun,
    };
  } finally {
    process.env = snapshot;
  }
}
