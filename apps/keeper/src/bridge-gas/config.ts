/**
 * Bridge gas keeper configuration.
 *
 * The Hyperlane USDC <-> USDC.e warp route charges every transfer a small
 * fee in the bridged asset (see infra/hyperlane/configs/warp-usdc.yaml).
 * Those fees accrue in a `LinearFee` contract next to each router, owned
 * by the relayer EOA. This job keeps that EOA fuelled on both chains
 * without anyone's treasury key:
 *
 *   1. sweep the fee contract into the keeper wallet (`claim`)
 *   2. if the keeper's native balance is under `minNative`, swap just
 *      enough USDC / USDC.e for wrapped gas on the chain's V2 router and
 *      unwrap it
 *
 * One leg per chain. A leg whose fee contract or stable address is unset
 * is reported as `unconfigured` and skipped, so the cron can be enabled
 * before the route is deployed.
 */

import 'dotenv/config';
import { isAddress, isHex, parseUnits, type Address, type Hex } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';

export interface BridgeGasLeg {
  /** Human label, also the env prefix (ETHEREUM / ETICA). */
  name: 'ethereum' | 'etica';
  chainId: number;
  rpcUrl: string;
  nativeSymbol: string;
  /** Hyperlane `LinearFee` contract the router forwards fees to. */
  feeContract: Address | null;
  /** The bridged stable on this chain (USDC on Ethereum, USDC.e on Etica). */
  stable: Address | null;
  stableDecimals: number;
  /** Uniswap-V2-style router used for the stable -> wrapped-native swap. */
  router: Address;
  /** WETH / WEGAZ: last hop of the path, unwrapped after the swap. */
  wrappedNative: Address;
  /** Full swap path, stable first and wrappedNative last. */
  path: Address[];
  /** Below this native balance the keeper tops up. */
  minNative: bigint;
  /** Top up to this native balance. */
  targetNative: bigint;
  /** Don't bother sweeping/swapping amounts smaller than this (stable units). */
  minStable: bigint;
}

export interface BridgeGasConfig {
  legs: BridgeGasLeg[];
  /** Max price impact tolerated on the swap vs. the marginal price, in BPS. */
  maxSlippageBps: number;
  /** Keeper signer. Required unless dryRun. */
  privateKey: Hex | null;
  dryRun: boolean;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export const ETHEREUM_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const ETHEREUM_WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const UNISWAP_V2_ROUTER: Address = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

function opt(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return v && v.length > 0 ? v : null;
}

function optAddress(env: NodeJS.ProcessEnv, name: string, fallback: string | null): Address | null {
  const v = opt(env, name) ?? fallback;
  if (v === null) return null;
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return v.toLowerCase() === ZERO ? null : (v as Address);
}

function reqAddress(env: NodeJS.ProcessEnv, name: string, fallback: string): Address {
  const v = optAddress(env, name, fallback);
  if (v === null) throw new Error(`${name} must be a non-zero address`);
  return v;
}

function optDecimal(env: NodeJS.ProcessEnv, name: string, fallback: string, decimals: number): bigint {
  const v = opt(env, name) ?? fallback;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${name} must be a decimal number, got: ${v}`);
  return parseUnits(v, decimals);
}

function optInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got: ${v}`);
  return n;
}

function leg(
  env: NodeJS.ProcessEnv,
  base: Omit<BridgeGasLeg, 'feeContract' | 'stable' | 'minNative' | 'targetNative' | 'minStable' | 'path' | 'rpcUrl' | 'router' | 'wrappedNative'> & {
    rpcDefault: string | null;
    router: string;
    wrappedNative: string;
    stableDefault: string | null;
    /** Intermediate hops between the stable and the wrapped native. */
    via: Address[];
    minNativeDefault: string;
    targetNativeDefault: string;
  },
): BridgeGasLeg {
  const P = base.name.toUpperCase();
  const rpcUrl = opt(env, `BRIDGE_GAS_${P}_RPC_URL`) ?? base.rpcDefault;
  if (!rpcUrl) throw new Error(`missing required env: BRIDGE_GAS_${P}_RPC_URL`);
  const minNative = optDecimal(env, `BRIDGE_GAS_${P}_MIN_NATIVE`, base.minNativeDefault, 18);
  const targetNative = optDecimal(env, `BRIDGE_GAS_${P}_TARGET_NATIVE`, base.targetNativeDefault, 18);
  if (targetNative <= minNative) {
    throw new Error(`BRIDGE_GAS_${P}_TARGET_NATIVE must exceed BRIDGE_GAS_${P}_MIN_NATIVE`);
  }
  const stable = optAddress(env, `BRIDGE_GAS_${P}_STABLE`, base.stableDefault);
  const router = reqAddress(env, `BRIDGE_GAS_${P}_ROUTER`, base.router);
  const wrappedNative = reqAddress(env, `BRIDGE_GAS_${P}_WRAPPED_NATIVE`, base.wrappedNative);
  return {
    name: base.name,
    chainId: optInt(env, `BRIDGE_GAS_${P}_CHAIN_ID`, base.chainId),
    rpcUrl,
    nativeSymbol: base.nativeSymbol,
    feeContract: optAddress(env, `BRIDGE_GAS_${P}_FEE_CONTRACT`, null),
    stable,
    stableDecimals: base.stableDecimals,
    router,
    wrappedNative,
    path: stable ? [stable, ...base.via, wrappedNative] : [],
    minNative,
    targetNative,
    minStable: optDecimal(env, `BRIDGE_GAS_${P}_MIN_STABLE`, '1', base.stableDecimals),
  };
}

export function loadBridgeGasConfig(env: NodeJS.ProcessEnv = process.env): BridgeGasConfig {
  const pk = opt(env, 'BRIDGE_GAS_PRIVATE_KEY') ?? opt(env, 'HARVEST_PRIVATE_KEY');
  if (pk !== null && !isHex(pk)) throw new Error('bridge-gas signer key must be 0x-prefixed hex');

  const dryRunRaw = opt(env, 'BRIDGE_GAS_DRY_RUN');
  const dryRun = dryRunRaw === null ? pk === null : /^(1|true|yes)$/i.test(dryRunRaw);

  const maxSlippageBps = optInt(env, 'BRIDGE_GAS_MAX_SLIPPAGE_BPS', 300);
  if (maxSlippageBps === 0 || maxSlippageBps > 2000) {
    throw new Error(`BRIDGE_GAS_MAX_SLIPPAGE_BPS must be in [1, 2000], got ${maxSlippageBps}`);
  }

  const etica = DEPLOYMENTS[eticaMainnet.id];
  const legs: BridgeGasLeg[] = [
    leg(env, {
      name: 'ethereum',
      chainId: 1,
      nativeSymbol: 'ETH',
      stableDecimals: 6,
      rpcDefault: null,
      router: UNISWAP_V2_ROUTER,
      wrappedNative: ETHEREUM_WETH,
      stableDefault: ETHEREUM_USDC,
      via: [],
      // Ethereum releases cost ~200k gas; 0.05 ETH is ~50 of them at 5 gwei.
      minNativeDefault: '0.05',
      targetNativeDefault: '0.15',
    }),
    leg(env, {
      name: 'etica',
      chainId: eticaMainnet.id,
      nativeSymbol: 'EGAZ',
      stableDecimals: 6,
      rpcDefault: opt(env, 'HARVEST_RPC_URL') ?? 'https://rpc2.etica-stats.org',
      router: etica.swapRouter,
      wrappedNative: etica.wegaz,
      // USDC.e exists only once the warp route is deployed.
      stableDefault: null,
      via: [etica.etx],
      minNativeDefault: '20',
      targetNativeDefault: '60',
    }),
  ];

  return { legs, maxSlippageBps, privateKey: pk as Hex | null, dryRun };
}
