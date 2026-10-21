/**
 * Configuration for the EticaSwap Direct fee harvest.
 *
 * Windows forward their swap fee in kind to the `DirectSwapHarvesterAdapter`
 * (the factory `feeTo`). This job sells what sits there to ETX on the hub and
 * lets the adapter split it 10/10/40/40. Signer: the keeper wallet, which the
 * harvester owner flagged with `setKeeper(keeper, true)`.
 */

import type { Address, Hex } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';

export interface DirectHarvestConfig {
  rpcUrl: string;
  chainId: number;
  factory: Address;
  harvester: Address;
  hubRouter: Address;
  etx: Address;
  /** Max slippage on every hub leg, in bps of the quoted amount. */
  maxSlippageBps: number;
  /** Skip the run when the whole harvest would yield less ETX than this (wei). */
  minEtxWei: bigint;
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

export function loadDirectHarvestConfig(env: NodeJS.ProcessEnv = process.env): DirectHarvestConfig {
  const chainId = optInt(env, 'HARVEST_CHAIN_ID', eticaMainnet.id);
  const deployment = DEPLOYMENTS[chainId as keyof typeof DEPLOYMENTS];
  const factory = optAddress(env, 'DIRECT_FACTORY_ADDRESS') ?? deployment?.directFactory ?? ZERO;
  const harvester =
    optAddress(env, 'DIRECT_HARVESTER_ADDRESS') ?? deployment?.directHarvesterAdapter ?? ZERO;
  if (factory === ZERO || harvester === ZERO) {
    throw new Error(
      'Direct factory/harvester unknown: set DIRECT_FACTORY_ADDRESS and DIRECT_HARVESTER_ADDRESS',
    );
  }
  const key = opt(env, 'HARVEST_PRIVATE_KEY');
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error('HARVEST_PRIVATE_KEY is not a 32-byte hex key');
  const minEtx = opt(env, 'DIRECT_HARVEST_MIN_ETX_WEI');
  return {
    rpcUrl: opt(env, 'HARVEST_RPC_URL') ?? 'https://eticamainnet.eticaprotocol.org',
    chainId,
    factory,
    harvester,
    hubRouter: optAddress(env, 'HARVEST_ROUTER_ADDRESS') ?? deployment?.swapRouter ?? ZERO,
    etx: optAddress(env, 'HARVEST_ETX_ADDRESS') ?? deployment?.etx ?? ZERO,
    maxSlippageBps: optInt(env, 'HARVEST_MAX_SLIPPAGE_BPS', 300),
    minEtxWei: minEtx ? BigInt(minEtx) : 10n ** 18n,
    privateKey: (key as Hex | null) ?? null,
    dryRun: truthy(opt(env, 'HARVEST_DRY_RUN')),
  };
}
