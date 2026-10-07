/**
 * Bridge seed — one-shot bootstrap of the USDC.e/ETX pool, signed by the
 * keeper key in GitHub Actions (`harvest-live`). Bridges the keeper's USDC
 * to its own Etica address, waits for the USDC.e mint, then opens the
 * USDC.e/ETX pair with the LP minted straight to the dead address so the
 * liquidity can never be withdrawn.
 *
 * Every address is pinned in code (same reasoning as bridge-gas: a router
 * or token reachable through workflow variables could redirect the seed).
 * Only amounts, the optional USD anchor and RPC endpoints are configurable.
 */

import { isAddress, isHex, parseUnits, type Address, type Hex } from 'viem';
import { DEPLOYMENTS, USDC_WARP_ROUTE, eticaMainnet } from '@etica-hub/shared';
import { ETHEREUM_MAILBOX, FLASHBOTS_PROTECT_RPC, PUBLIC_ETHEREUM_RPCS } from '../bridge-gas/config.js';

export { ETHEREUM_MAILBOX, FLASHBOTS_PROTECT_RPC, PUBLIC_ETHEREUM_RPCS };

export const DEAD_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';
export const STABLE_DECIMALS = USDC_WARP_ROUTE.decimals;
export const ETX_DECIMALS = 18;
/** Hyperlane domain id of Etica (== chain id). */
export const ETICA_DOMAIN = eticaMainnet.id;

export interface BridgeSeedConfig {
  privateKey: Hex | null;
  dryRun: boolean;
  /** ETX side of the pool (wei). The pair-creation fee is on top of this. */
  etxAmount: bigint;
  /** USDC to bridge and pool (6 dp); null = everything the wallet can afford including the bridge fee. */
  usdcAmount: bigint | null;
  /** EGAZ/USD anchor (1e18 fixed point); null = skip the market-price check. */
  egazUsd: bigint | null;
  /** Max |pool price - ETX/WEGAZ implied price| in BPS when `egazUsd` is set. */
  maxPriceDeviationBps: number;
  /** addLiquidity min amounts = desired * (1 - this). */
  liquiditySlippageBps: number;
  /** How long a live run waits for the USDC.e mint before failing (re-dispatch resumes). */
  mintTimeoutMs: number;
  ethereum: {
    chainId: 1;
    rpcUrls: string[];
    writeRpcUrl: string;
    usdc: Address;
    warpRouter: Address;
    mailbox: Address;
  };
  etica: {
    chainId: typeof eticaMainnet.id;
    rpcUrls: string[];
    usdce: Address;
    etx: Address;
    wegaz: Address;
    swapFactory: Address;
    swapRouter: Address;
  };
}

function opt(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return v && v.length > 0 ? v : null;
}

function optDecimal(env: NodeJS.ProcessEnv, name: string, decimals: number): bigint | null {
  const v = opt(env, name);
  if (v === null) return null;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${name} must be a decimal number, got: ${v}`);
  return parseUnits(v, decimals);
}

function optInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = opt(env, name);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got: ${v}`);
  return n;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Comma-separated URL list; public failover appended unless a loopback fork is configured. */
function rpcList(name: string, raw: string | null, failover: readonly string[]): string[] {
  const configured = (raw ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  for (const url of configured) {
    if (!/^https?:\/\//.test(url)) throw new Error(`${name} must be http(s) URL(s), got: ${url}`);
  }
  const urls = configured.some(isLoopback) ? configured : [...configured, ...failover];
  return Array.from(new Set(urls));
}

export function loadBridgeSeedConfig(env: NodeJS.ProcessEnv = process.env): BridgeSeedConfig {
  const pk = opt(env, 'BRIDGE_SEED_PRIVATE_KEY') ?? opt(env, 'HARVEST_PRIVATE_KEY');
  if (pk !== null && !isHex(pk)) throw new Error('bridge-seed signer key must be 0x-prefixed hex');
  const dryRunRaw = opt(env, 'BRIDGE_SEED_DRY_RUN');
  const dryRun = dryRunRaw === null ? pk === null : /^(1|true|yes)$/i.test(dryRunRaw);

  const etxAmount = optDecimal(env, 'BRIDGE_SEED_ETX_AMOUNT', ETX_DECIMALS);
  if (etxAmount === null || etxAmount === 0n) throw new Error('BRIDGE_SEED_ETX_AMOUNT must be a positive ETX amount');
  const usdcAmount = optDecimal(env, 'BRIDGE_SEED_USDC_AMOUNT', STABLE_DECIMALS);
  if (usdcAmount === 0n) throw new Error('BRIDGE_SEED_USDC_AMOUNT must be positive when set');
  const egazUsd = optDecimal(env, 'BRIDGE_SEED_EGAZ_USD', 18);
  if (egazUsd === 0n) throw new Error('BRIDGE_SEED_EGAZ_USD must be positive when set');

  const maxPriceDeviationBps = optInt(env, 'BRIDGE_SEED_MAX_PRICE_DEVIATION_BPS', 300);
  if (maxPriceDeviationBps === 0 || maxPriceDeviationBps > 2_000) {
    throw new Error(`BRIDGE_SEED_MAX_PRICE_DEVIATION_BPS must be in [1, 2000], got ${maxPriceDeviationBps}`);
  }
  const liquiditySlippageBps = optInt(env, 'BRIDGE_SEED_LIQUIDITY_SLIPPAGE_BPS', 50);
  if (liquiditySlippageBps > 500) throw new Error('BRIDGE_SEED_LIQUIDITY_SLIPPAGE_BPS must be <= 500');
  const mintTimeoutS = optInt(env, 'BRIDGE_SEED_MINT_TIMEOUT_S', 2_400);
  if (mintTimeoutS === 0) throw new Error('BRIDGE_SEED_MINT_TIMEOUT_S must be positive');

  const ethRpcUrls = rpcList('BRIDGE_SEED_ETHEREUM_RPC_URL', opt(env, 'BRIDGE_SEED_ETHEREUM_RPC_URL'), PUBLIC_ETHEREUM_RPCS);
  const ethWrite = opt(env, 'BRIDGE_SEED_ETHEREUM_WRITE_RPC_URL') ?? (ethRpcUrls.every(isLoopback) ? ethRpcUrls[0]! : FLASHBOTS_PROTECT_RPC);
  if (!/^https?:\/\//.test(ethWrite)) throw new Error('BRIDGE_SEED_ETHEREUM_WRITE_RPC_URL must be an http(s) URL');
  const mailboxOverride = opt(env, 'BRIDGE_SEED_ETHEREUM_MAILBOX');
  if (mailboxOverride !== null && !ethRpcUrls.every(isLoopback)) {
    throw new Error('BRIDGE_SEED_ETHEREUM_MAILBOX may only be set when the Ethereum RPC is a local fork');
  }
  if (mailboxOverride !== null && !isAddress(mailboxOverride)) throw new Error('BRIDGE_SEED_ETHEREUM_MAILBOX is not an address');

  const eticaRpcUrls = rpcList('BRIDGE_SEED_ETICA_RPC_URL', opt(env, 'BRIDGE_SEED_ETICA_RPC_URL'), [
    opt(env, 'HARVEST_RPC_URL') ?? 'https://rpc2.etica-stats.org',
    ...eticaMainnet.rpcUrls.default.http,
  ]);

  const etica = DEPLOYMENTS[eticaMainnet.id];
  return {
    privateKey: pk as Hex | null,
    dryRun,
    etxAmount,
    usdcAmount,
    egazUsd,
    maxPriceDeviationBps,
    liquiditySlippageBps,
    mintTimeoutMs: mintTimeoutS * 1_000,
    ethereum: {
      chainId: 1,
      rpcUrls: ethRpcUrls,
      writeRpcUrl: ethWrite,
      usdc: USDC_WARP_ROUTE.collateralToken,
      warpRouter: USDC_WARP_ROUTE.collateralRouter,
      mailbox: (mailboxOverride as Address | null) ?? ETHEREUM_MAILBOX,
    },
    etica: {
      chainId: eticaMainnet.id,
      rpcUrls: eticaRpcUrls,
      usdce: USDC_WARP_ROUTE.syntheticToken,
      etx: etica.etx,
      wegaz: etica.wegaz,
      swapFactory: etica.swapFactory,
      swapRouter: etica.swapRouter,
    },
  };
}
