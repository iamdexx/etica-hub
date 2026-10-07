/**
 * Forfeit-sweep configuration.
 *
 * The sweep settles abandoned Labs research — records past the 7-day
 * open-market window that nobody minted — by submitting the platform's
 * signed `claim()` attestation from a funded keeper EOA. Past that window
 * the contract force-mints to the treasury and waives the fee, so the
 * keeper only ever spends gas and can never redirect an NFT to itself.
 *
 * It deliberately reads the same `HARVEST_*` signer/RPC variables as the
 * farm harvest so both cranks share one funded, unprivileged EOA.
 */

import 'dotenv/config';
import { isAddress, isHex, parseEther, type Address, type Hex } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';

export interface ForfeitConfig {
  /** RPC endpoint for reads + tx submission. */
  rpcUrl: string;
  /** Chain ID. Etica mainnet = 61803. */
  chainId: number;
  /** EticaResearchNFT. */
  nft: Address;
  /** Treasury — the only address a matured claim can mint to. */
  treasury: Address;
  /**
   * EticaResearchMarketplace with `listAbandoned`; treasury-held tokens
   * are put on sale there after settlement. Null disables auto-listing.
   */
  marketplace: Address | null;
  /** Treasury tokens to list per run. */
  maxListPerRun: number;
  /** Origin serving /api/labs/treasury/attestations. */
  baseUrl: string;
  /** Optional Labs worker token; bypasses the public rate limit. */
  workerToken: string | null;
  /** Records to settle per run. */
  maxPerRun: number;
  /**
   * Keeper EGAZ balance (wei) below which the sweep does nothing. The same
   * EOA pays for the daily farm harvest; the hourly sweep must never spend
   * it down to where the harvest (and the farms' reward distribution) stalls.
   */
  minKeeperBalanceWei: bigint;
  /** Gas-paying signer. Required unless dryRun. */
  privateKey: Hex | null;
  /** When true, simulate every claim but submit nothing. */
  dryRun: boolean;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return v && v.length > 0 ? v : null;
}

function optInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${v}`);
  }
  return n;
}

function address(env: NodeJS.ProcessEnv, name: string, fallback: string): Address {
  const v = opt(env, name) ?? fallback;
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return v as Address;
}

export const DEFAULT_NFT = '0x4B7673665543bC1ABf13a023Ae2A04e91A4259f9';
export const DEFAULT_TREASURY = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';
export const DEFAULT_MARKETPLACE = DEPLOYMENTS[eticaMainnet.id].eticaResearchMarketplace;
const ZERO = '0x0000000000000000000000000000000000000000';

export function loadForfeitConfig(env: NodeJS.ProcessEnv = process.env): ForfeitConfig {
  const pk = opt(env, 'FORFEIT_PRIVATE_KEY') ?? opt(env, 'HARVEST_PRIVATE_KEY');
  if (pk !== null && !isHex(pk)) {
    throw new Error('forfeit signer key must be 0x-prefixed hex');
  }

  const dryRunRaw = opt(env, 'FORFEIT_DRY_RUN');
  const dryRun = dryRunRaw === null ? pk === null : /^(1|true|yes)$/i.test(dryRunRaw);

  const maxPerRun = optInt(env, 'FORFEIT_MAX_PER_RUN', 10);
  if (maxPerRun === 0 || maxPerRun > 25) {
    throw new Error(`FORFEIT_MAX_PER_RUN must be in [1, 25], got ${maxPerRun}`);
  }
  const maxListPerRun = optInt(env, 'FORFEIT_MAX_LIST_PER_RUN', 10);
  if (maxListPerRun > 50) {
    throw new Error(`FORFEIT_MAX_LIST_PER_RUN must be in [0, 50], got ${maxListPerRun}`);
  }

  // The marketplace is optional: an explicit "off" or an unset deployment
  // (zero address) simply skips the listing step.
  const marketplaceRaw = opt(env, 'FORFEIT_MARKETPLACE_ADDRESS');
  let marketplace: Address | null;
  if (marketplaceRaw !== null && /^(0|off|false|none)$/i.test(marketplaceRaw)) {
    marketplace = null;
  } else {
    const v = marketplaceRaw ?? DEFAULT_MARKETPLACE;
    if (!isAddress(v)) throw new Error(`FORFEIT_MARKETPLACE_ADDRESS is not an address: ${v}`);
    marketplace = v.toLowerCase() === ZERO ? null : (v as Address);
  }

  const minKeeperRaw = opt(env, 'FORFEIT_MIN_KEEPER_EGAZ') ?? '5';
  if (!/^\d+(\.\d+)?$/.test(minKeeperRaw)) {
    throw new Error(`FORFEIT_MIN_KEEPER_EGAZ must be a decimal EGAZ amount, got: ${minKeeperRaw}`);
  }
  const minKeeperBalanceWei = parseEther(minKeeperRaw);

  const baseUrl = (opt(env, 'FORFEIT_BASE_URL') ?? 'https://eticahub.com').replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) {
    throw new Error(`FORFEIT_BASE_URL must be https (or local http), got: ${baseUrl}`);
  }

  return {
    rpcUrl: opt(env, 'FORFEIT_RPC_URL') ?? opt(env, 'HARVEST_RPC_URL') ?? 'https://rpc2.etica-stats.org',
    chainId: optInt(env, 'FORFEIT_CHAIN_ID', optInt(env, 'HARVEST_CHAIN_ID', 61803)),
    nft: address(env, 'FORFEIT_NFT_ADDRESS', DEFAULT_NFT),
    treasury: address(env, 'FORFEIT_TREASURY_ADDRESS', DEFAULT_TREASURY),
    marketplace,
    maxListPerRun,
    baseUrl,
    workerToken: opt(env, 'FORFEIT_WORKER_TOKEN') ?? opt(env, 'LABS_AUTOPILOT_TOKEN'),
    maxPerRun,
    minKeeperBalanceWei,
    privateKey: pk as Hex | null,
    dryRun,
  };
}
