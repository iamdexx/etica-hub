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
 *   3. turn the surplus into EGAZ for the keeper: on Etica it is swapped
 *      along the pinned USDC.e -> ETX -> WEGAZ path in bounded chunks and
 *      unwrapped, with no upper target — the keeper's gas pile just grows;
 *      on Ethereum the surplus USDC is bridged over the warp route to the
 *      keeper's own Etica wallet, where the next run swaps it. Fee revenue
 *      never reaches any other wallet, and no recipient is configurable
 *      from the environment.
 *
 * One leg per chain. A leg whose fee contract or stable address is unset
 * is reported as `unconfigured` and skipped, so the cron can be enabled
 * before the route is deployed.
 */

import 'dotenv/config';
import { isAddress, isHex, parseUnits, type Address, type Hex } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';
import { DEAD_ADDRESS } from '../harvest/config.js';

export { DEAD_ADDRESS };

export interface BridgeGasLeg {
  /** Human label, also the env prefix (ETHEREUM / ETICA). */
  name: 'ethereum' | 'etica';
  chainId: number;
  /** First read endpoint; `rpcUrls` is the full failover list it heads. */
  rpcUrl: string;
  /**
   * Read endpoints in failover order. Reads are plain `eth_call`/balance
   * lookups plus the gas-drop log scan, all verified against on-chain state
   * (fee-contract owner, router bindings, mailbox), so a lying or flaky
   * endpoint can only make a run skip or retry, never misdirect funds.
   */
  rpcUrls: string[];
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
  /** Don't bother claiming/swapping amounts smaller than this (stable units). */
  minStable: bigint;
  /** Stable kept in the keeper wallet as a gas-buying reserve; the rest is swapped to EGAZ / bridged to be swapped. */
  reserveStable: bigint;
  /** Only release the surplus when it is at least this (amortises gas). */
  minSweep: bigint;
  /**
   * Where the surplus goes. Ethereum: the collateral warp router the USDC is
   * bridged through (verified on-chain against `ethereumMailbox`, the Etica
   * route and the fee contract before every send). Etica: swapped along
   * `path` to EGAZ and kept in the keeper wallet, at most `maxChunk` stable
   * per run (the rest waits for the next run).
   */
  surplus:
    | { kind: 'bridge-to-etica'; warpRouter: Address | null }
    | { kind: 'swap-to-native'; maxChunk: bigint };
  /**
   * RPC used for *sending* transactions. On Ethereum this defaults to Flashbots
   * Protect so the keeper's swaps never sit in the public mempool (no sandwich
   * exposure); reads always go through `rpcUrl`.
   */
  writeRpcUrl: string;
}

export interface GasDropConfig {
  /** EGAZ sent to a fresh recipient (wei). */
  amount: bigint;
  /** Recipients already holding at least this much EGAZ are skipped. */
  threshold: bigint;
  /** Minimum USDC.e received for a transfer to qualify (stable units). */
  minTransfer: bigint;
  /** Hard cap on drops per run (bounds what a bugged/abused scan can spend). */
  maxPerRun: number;
  /** How far back to scan `ReceivedTransferRemote` logs; overlaps between hourly runs are fine. */
  lookbackBlocks: bigint;
}

export interface BridgeGasConfig {
  legs: BridgeGasLeg[];
  /**
   * Hyperlane Mailbox the Ethereum collateral router must be bound to. Pinned
   * to the canonical Ethereum mailbox; only a loopback RPC (local fork) may
   * override it, so a poisoned workflow variable cannot point the keeper at a
   * look-alike router that keeps the USDC.
   */
  ethereumMailbox: Address;
  /** Recipient gas drop on the Etica leg, or null when disabled. */
  gasDrop: GasDropConfig | null;
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
/** Hyperlane's canonical Ethereum mainnet Mailbox (hyperlane-registry chains/ethereum/addresses.yaml). */
export const ETHEREUM_MAILBOX: Address = '0xc005dc82818d67AF737725bD4bf75435d065D239';
/** Hyperlane domain id of Etica (== chain id). */
export const ETICA_DOMAIN = eticaMainnet.id;
/** Flashbots Protect: private tx submission, falls through to public builders only after being unseen for a while. */
export const FLASHBOTS_PROTECT_RPC = 'https://rpc.flashbots.net/fast';

/**
 * Public Ethereum endpoints that serve `eth_call`, balances and bounded
 * `eth_getLogs` ranges without a key (probed 2026-10; order = preference).
 * Used as the default read set and appended after any configured URL as
 * failover. Writes never go here: they use `writeRpcUrl` (Flashbots Protect).
 */
export const PUBLIC_ETHEREUM_RPCS: readonly string[] = [
  'https://gateway.tenderly.co/public/mainnet',
  'https://rpc.mevblocker.io',
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
];

/** Comma-separated URL list -> trimmed, de-duplicated, every entry http(s). */
function rpcList(name: string, raw: string | null, failover: readonly string[]): string[] {
  const configured = (raw ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  for (const url of configured) {
    if (!/^https?:\/\//.test(url)) throw new Error(`${name} must be http(s) URL(s), got: ${url}`);
  }
  // A loopback (fork) endpoint must stay alone: public failovers would answer
  // from mainnet state and silently mix two chains into one run.
  const urls = configured.some(isLoopback) ? configured : [...configured, ...failover];
  return Array.from(new Set(urls));
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

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
  base: Omit<BridgeGasLeg, 'feeContract' | 'stable' | 'minNative' | 'targetNative' | 'minStable' | 'reserveStable' | 'minSweep' | 'writeRpcUrl' | 'path' | 'rpcUrl' | 'rpcUrls' | 'router' | 'wrappedNative' | 'surplus'> & {
    /** Configured endpoint(s) win; these are appended as failover. */
    rpcFailover: readonly string[];
    router: string;
    wrappedNative: string;
    stableDefault: string | null;
    /** Intermediate hops between the stable and the wrapped native. */
    via: Address[];
    minNativeDefault: string;
    targetNativeDefault: string;
    minStableDefault: string;
    reserveStableDefault: string;
    minSweepDefault: string;
    writeRpcDefault: string | null;
    surplus: BridgeGasLeg['surplus'];
  },
): BridgeGasLeg {
  const P = base.name.toUpperCase();
  const rpcUrls = rpcList(`BRIDGE_GAS_${P}_RPC_URL`, opt(env, `BRIDGE_GAS_${P}_RPC_URL`), base.rpcFailover);
  if (rpcUrls.length === 0) throw new Error(`missing required env: BRIDGE_GAS_${P}_RPC_URL`);
  const rpcUrl = rpcUrls[0]!;
  const writeRpcUrl = opt(env, `BRIDGE_GAS_${P}_WRITE_RPC_URL`) ?? base.writeRpcDefault ?? rpcUrl;
  if (!/^https?:\/\//.test(writeRpcUrl)) throw new Error(`BRIDGE_GAS_${P}_WRITE_RPC_URL must be an http(s) URL`);
  const minStable = optDecimal(env, `BRIDGE_GAS_${P}_MIN_STABLE`, base.minStableDefault, base.stableDecimals);
  const reserveStable = optDecimal(env, `BRIDGE_GAS_${P}_RESERVE_STABLE`, base.reserveStableDefault, base.stableDecimals);
  const minSweep = optDecimal(env, `BRIDGE_GAS_${P}_MIN_SWEEP`, base.minSweepDefault, base.stableDecimals);
  if (minSweep === 0n) throw new Error(`BRIDGE_GAS_${P}_MIN_SWEEP must be positive`);
  if (base.surplus.kind === 'swap-to-native' && base.surplus.maxChunk < minSweep) {
    throw new Error(`BRIDGE_GAS_${P}_MAX_SURPLUS_SWAP must be at least BRIDGE_GAS_${P}_MIN_SWEEP`);
  }
  const minNative = optDecimal(env, `BRIDGE_GAS_${P}_MIN_NATIVE`, base.minNativeDefault, 18);
  const targetNative = optDecimal(env, `BRIDGE_GAS_${P}_TARGET_NATIVE`, base.targetNativeDefault, 18);
  if (targetNative <= minNative) {
    throw new Error(`BRIDGE_GAS_${P}_TARGET_NATIVE must exceed BRIDGE_GAS_${P}_MIN_NATIVE`);
  }
  const stable = optAddress(env, `BRIDGE_GAS_${P}_STABLE`, base.stableDefault);
  // Swap router, wrapped-native and the swap path are pinned in code: a hostile
  // router/path reachable through workflow variables could route every claimed
  // fee into an attacker pool, so they are not configurable.
  const router = base.router as Address;
  const wrappedNative = base.wrappedNative as Address;
  return {
    name: base.name,
    chainId: optInt(env, `BRIDGE_GAS_${P}_CHAIN_ID`, base.chainId),
    rpcUrl,
    rpcUrls,
    nativeSymbol: base.nativeSymbol,
    feeContract: optAddress(env, `BRIDGE_GAS_${P}_FEE_CONTRACT`, null),
    stable,
    stableDecimals: base.stableDecimals,
    router,
    wrappedNative,
    path: stable ? [stable, ...base.via, wrappedNative] : [],
    minNative,
    targetNative,
    minStable,
    reserveStable,
    minSweep,
    writeRpcUrl,
    surplus: base.surplus,
  };
}

export function loadBridgeGasConfig(env: NodeJS.ProcessEnv = process.env): BridgeGasConfig {
  const pk = opt(env, 'BRIDGE_GAS_PRIVATE_KEY') ?? opt(env, 'HARVEST_PRIVATE_KEY');
  if (pk !== null && !isHex(pk)) throw new Error('bridge-gas signer key must be 0x-prefixed hex');

  const dryRunRaw = opt(env, 'BRIDGE_GAS_DRY_RUN');
  const dryRun = dryRunRaw === null ? pk === null : /^(1|true|yes)$/i.test(dryRunRaw);

  // 1.5%: wide enough for the thin USDC.e/ETX pool on a normal day, tight
  // enough that a sandwich on the Etica leg (public mempool) is capped at
  // 1.5% of a swap that is itself capped by `targetNative`.
  const maxSlippageBps = optInt(env, 'BRIDGE_GAS_MAX_SLIPPAGE_BPS', 150);
  if (maxSlippageBps === 0 || maxSlippageBps > 500) {
    throw new Error(`BRIDGE_GAS_MAX_SLIPPAGE_BPS must be in [1, 500], got ${maxSlippageBps}`);
  }

  const etica = DEPLOYMENTS[eticaMainnet.id];
  const legs: BridgeGasLeg[] = [
    leg(env, {
      name: 'ethereum',
      chainId: 1,
      nativeSymbol: 'ETH',
      stableDecimals: 6,
      rpcFailover: PUBLIC_ETHEREUM_RPCS,
      router: UNISWAP_V2_ROUTER,
      wrappedNative: ETHEREUM_WETH,
      stableDefault: ETHEREUM_USDC,
      via: [],
      // Ethereum releases cost ~200k gas; 0.05 ETH is ~50 of them at 5 gwei.
      minNativeDefault: '0.05',
      targetNativeDefault: '0.15',
      // A claim + sweep is ~2 Ethereum txs; only do it once >= 200 USDC accrued (<~2% overhead).
      minStableDefault: '200',
      // Enough to buy a full ETH top-up at any plausible gas price without waiting for new fees.
      reserveStableDefault: '500',
      minSweepDefault: '200',
      writeRpcDefault: FLASHBOTS_PROTECT_RPC,
      // The collateral router comes from the warp deploy output; unset = surplus is held.
      surplus: { kind: 'bridge-to-etica', warpRouter: optAddress(env, 'BRIDGE_GAS_ETHEREUM_WARP_ROUTER', null) },
    }),
    leg(env, {
      name: 'etica',
      chainId: eticaMainnet.id,
      nativeSymbol: 'EGAZ',
      stableDecimals: 6,
      rpcFailover: [opt(env, 'HARVEST_RPC_URL') ?? 'https://rpc2.etica-stats.org', ...eticaMainnet.rpcUrls.default.http],
      router: etica.swapRouter,
      wrappedNative: etica.wegaz,
      // USDC.e exists only once the warp route is deployed.
      stableDefault: null,
      via: [etica.etx],
      minNativeDefault: '20',
      targetNativeDefault: '60',
      minStableDefault: '5',
      reserveStableDefault: '500',
      minSweepDefault: '5',
      writeRpcDefault: null,
      surplus: { kind: 'swap-to-native', maxChunk: optDecimal(env, 'BRIDGE_GAS_ETICA_MAX_SURPLUS_SWAP', '250', 6) },
    }),
  ];

  const mailboxOverride = opt(env, 'BRIDGE_GAS_ETHEREUM_MAILBOX');
  if (mailboxOverride !== null && !legs[0]!.rpcUrls.every(isLoopback)) {
    throw new Error('BRIDGE_GAS_ETHEREUM_MAILBOX may only be set when the Ethereum RPC is a local fork');
  }
  const ethereumMailbox = mailboxOverride !== null ? reqAddress(env, 'BRIDGE_GAS_ETHEREUM_MAILBOX', ETHEREUM_MAILBOX) : ETHEREUM_MAILBOX;

  const gasDrop = loadGasDropConfig(env);
  return { legs, ethereumMailbox, gasDrop, maxSlippageBps, privateKey: pk as Hex | null, dryRun };
}

/**
 * Recipient gas drop: a fresh wallet that just received USDC.e cannot move
 * it without EGAZ. Disabled with BRIDGE_GAS_DROP_ENABLED=false.
 */
export function loadGasDropConfig(env: NodeJS.ProcessEnv): GasDropConfig | null {
  const enabled = opt(env, 'BRIDGE_GAS_DROP_ENABLED');
  if (enabled !== null && /^(0|false|no)$/i.test(enabled)) return null;
  const amount = optDecimal(env, 'BRIDGE_GAS_DROP_AMOUNT', '2', 18);
  const threshold = optDecimal(env, 'BRIDGE_GAS_DROP_THRESHOLD', '0.5', 18);
  if (amount === 0n) throw new Error('BRIDGE_GAS_DROP_AMOUNT must be positive');
  if (threshold >= amount) throw new Error('BRIDGE_GAS_DROP_THRESHOLD must be below BRIDGE_GAS_DROP_AMOUNT');
  const maxPerRun = optInt(env, 'BRIDGE_GAS_DROP_MAX_PER_RUN', 25);
  if (maxPerRun === 0 || maxPerRun > 200) throw new Error('BRIDGE_GAS_DROP_MAX_PER_RUN must be in [1, 200]');
  const lookbackBlocks = optInt(env, 'BRIDGE_GAS_DROP_LOOKBACK_BLOCKS', 600);
  if (lookbackBlocks === 0 || lookbackBlocks > 5000) throw new Error('BRIDGE_GAS_DROP_LOOKBACK_BLOCKS must be in [1, 5000]');
  return {
    amount,
    threshold,
    // A qualifying transfer pays >= 10 cents in fees; a drop costs well under one.
    minTransfer: optDecimal(env, 'BRIDGE_GAS_DROP_MIN_TRANSFER', '20', 6),
    maxPerRun,
    lookbackBlocks: BigInt(lookbackBlocks),
  };
}
