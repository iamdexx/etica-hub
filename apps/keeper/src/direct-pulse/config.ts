/**
 * Configuration for the EticaSwap Direct daily pulse.
 *
 * Trackers (CoinGecko, GeckoTerminal) drop a pair that shows no trade for a
 * day. Windows only move when someone swaps them, so once a day the keeper
 * wallet runs a small EGAZ round trip through every window that has been
 * quiet, then ends back in EGAZ. Signer: the keeper wallet, which the
 * factory admin whitelisted (`setWhitelist(keeper, true)`) so the 40k stETX
 * gate lets it through.
 */

import type { Address, Hex } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';

export interface DirectPulseConfig {
  rpcUrl: string;
  chainId: number;
  factory: Address;
  router: Address;
  wegaz: Address;
  /** EGAZ spent per round trip (wei). */
  amountWei: bigint;
  /** A window with a Swap younger than this is left alone. */
  maxQuietSeconds: number;
  /** Max slippage per leg, in bps of the quoted amount. */
  maxSlippageBps: number;
  /** Cap on a trip's size, in bps of the first window's EGAZ-side reserve. */
  maxReserveBps: number;
  privateKey: Hex | null;
  dryRun: boolean;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return v && v.trim().length > 0 ? v.trim() : null;
}

function optAddress(env: NodeJS.ProcessEnv, name: string): Address | null {
  const v = opt(env, name);
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not an address: ${v}`);
  return v as Address;
}

function optInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = opt(env, name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function truthy(v: string | null): boolean {
  return v !== null && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export function loadDirectPulseConfig(env: NodeJS.ProcessEnv = process.env): DirectPulseConfig {
  const chainId = optInt(env, 'HARVEST_CHAIN_ID', eticaMainnet.id);
  const deployment = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS];
  const factory = optAddress(env, 'DIRECT_FACTORY_ADDRESS') ?? deployment?.directFactory ?? ZERO;
  const router = optAddress(env, 'DIRECT_ROUTER_ADDRESS') ?? deployment?.directRouter ?? ZERO;
  const wegaz = optAddress(env, 'DIRECT_WEGAZ_ADDRESS') ?? deployment?.wegaz ?? ZERO;
  if (factory === ZERO || router === ZERO || wegaz === ZERO) {
    throw new Error(
      'Direct factory/router/WEGAZ unknown: set DIRECT_FACTORY_ADDRESS, DIRECT_ROUTER_ADDRESS, DIRECT_WEGAZ_ADDRESS',
    );
  }
  const key = opt(env, 'HARVEST_PRIVATE_KEY');
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error('HARVEST_PRIVATE_KEY is not a 32-byte hex key');
  const amount = opt(env, 'DIRECT_PULSE_EGAZ_WEI');
  return {
    rpcUrl: opt(env, 'HARVEST_RPC_URL') ?? 'https://rpc.eticahub.com',
    chainId,
    factory,
    router,
    wegaz,
    amountWei: amount ? BigInt(amount) : 250n * 10n ** 18n,
    maxQuietSeconds: optInt(env, 'DIRECT_PULSE_MAX_QUIET_SECONDS', 20 * 3600),
    maxSlippageBps: optInt(env, 'HARVEST_MAX_SLIPPAGE_BPS', 300),
    maxReserveBps: optInt(env, 'DIRECT_PULSE_MAX_RESERVE_BPS', 200),
    privateKey: (key as Hex | null) ?? null,
    dryRun: truthy(opt(env, 'HARVEST_DRY_RUN')),
  };
}
