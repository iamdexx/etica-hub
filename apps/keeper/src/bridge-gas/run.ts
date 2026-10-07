/**
 * Bridge gas runner — snapshots each leg, lets `plan.ts` decide, and
 * either logs (dry-run) or submits, in order: claim(keeper) on the fee
 * contract, approve + swapExactTokensForTokens(stable -> ... -> wrapped
 * native) + wrapped.withdraw(), transfer(treasury, surplus), and on Etica
 * the recipient gas drops. Every send goes through `leg.writeRpcUrl`
 * (Flashbots Protect on Ethereum); reads use `leg.rpcUrl`.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { abis } from '@etica-hub/shared';
import type { BridgeGasConfig, BridgeGasLeg } from './config.js';
import { fetchInboundTransfers, planGasDrops } from './gas-drop.js';
import { decideLeg, type LegDecision, type LegSnapshot, type SwapQuote } from './plan.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

const FEE_ABI = parseAbi([
  'function owner() view returns (address)',
  'function token() view returns (address)',
  'function claim(address beneficiary)',
]);

const ROUTER_ABI = parseAbi([
  'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

const DEADLINE_BUFFER_S = 300;

export interface LegResult {
  leg: BridgeGasLeg['name'];
  /**
   * idle      nothing to do
   * executed  at least one tx sent (claim / swap / sweep / gas drop)
   * planned   dry run with work pending
   * blocked   gas is low and no swap could be planned (fees still claimed/held)
   */
  status: 'unconfigured' | 'idle' | 'executed' | 'planned' | 'blocked' | 'error';
  nativeBalance?: string;
  feeContractBalance?: string;
  walletStable?: string;
  claimed?: string;
  swappedIn?: string;
  nativeReceived?: string;
  swept?: string;
  gasDrops?: number;
  reason?: string;
  txHashes: Hex[];
}

export interface BridgeGasRunResult {
  dryRun: boolean;
  legs: LegResult[];
  error?: string;
}

interface Clients {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
  account: PrivateKeyAccount | null;
}

function makeClients(leg: BridgeGasLeg, config: BridgeGasConfig): Clients {
  const chain = defineChain({
    id: leg.chainId,
    name: leg.name,
    nativeCurrency: { name: leg.nativeSymbol, symbol: leg.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [leg.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(leg.rpcUrl) }) as PublicClient;
  const account = config.privateKey ? privateKeyToAccount(config.privateKey) : null;
  const walletClient =
    account && !config.dryRun
      ? createWalletClient({ account, chain, transport: http(leg.writeRpcUrl) })
      : null;
  return { publicClient, walletClient, account };
}

export async function snapshotLeg(
  client: PublicClient,
  leg: BridgeGasLeg,
  keeper: Address,
): Promise<LegSnapshot> {
  const feeContract = leg.feeContract as Address;
  const stable = leg.stable as Address;
  const [nativeBalance, feeOwner, feeToken, feeContractBalance, walletStable] = await Promise.all([
    client.getBalance({ address: keeper }),
    client.readContract({ address: feeContract, abi: FEE_ABI, functionName: 'owner' }),
    client.readContract({ address: feeContract, abi: FEE_ABI, functionName: 'token' }),
    client.readContract({ address: stable, abi: abis.erc20Abi, functionName: 'balanceOf', args: [feeContract] }),
    client.readContract({ address: stable, abi: abis.erc20Abi, functionName: 'balanceOf', args: [keeper] }),
  ]);
  if (feeToken.toLowerCase() !== stable.toLowerCase()) {
    throw new Error(`fee contract ${feeContract} collects ${feeToken}, configured stable is ${stable}`);
  }
  return {
    nativeBalance,
    feeContractBalance,
    walletStable,
    keeperOwnsFeeContract: feeOwner.toLowerCase() === keeper.toLowerCase(),
  };
}

export async function quoteLeg(
  client: PublicClient,
  leg: BridgeGasLeg,
  nativeNeeded: bigint,
): Promise<SwapQuote | null> {
  const probeIn = 10n ** BigInt(leg.stableDecimals); // one unit of stable
  try {
    const [amountsIn, probeAmounts] = await Promise.all([
      client.readContract({ address: leg.router, abi: ROUTER_ABI, functionName: 'getAmountsIn', args: [nativeNeeded, leg.path] }),
      client.readContract({ address: leg.router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [probeIn, leg.path] }),
    ]);
    const amountIn = amountsIn[0];
    const probeOut = probeAmounts[probeAmounts.length - 1];
    if (amountIn === undefined || probeOut === undefined) return null;
    const amountsOut = await client.readContract({
      address: leg.router,
      abi: ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [amountIn, leg.path],
    });
    const amountOut = amountsOut[amountsOut.length - 1];
    if (amountOut === undefined) return null;
    return { amountIn, amountOut, probeIn, probeOut };
  } catch {
    return null;
  }
}

async function confirm(
  leg: BridgeGasLeg,
  publicClient: PublicClient,
  hash: Hex,
  label: string,
  log: Logger,
): Promise<void> {
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  log.info(`[bridge-gas:${leg.name}] ${label} ${hash}`);
}

/**
 * Unwrap any wrapped native already sitting in the keeper wallet — e.g.
 * left behind by a run that swapped but died before `withdraw`. Returns
 * the tx hash if one was sent.
 */
async function unwrapStranded(
  leg: BridgeGasLeg,
  { publicClient, walletClient, account }: Clients,
  log: Logger,
): Promise<Hex | null> {
  if (!walletClient || !account) return null;
  const wrapped = await publicClient.readContract({
    address: leg.wrappedNative,
    abi: abis.erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  if (wrapped === 0n) return null;
  const hash = await walletClient.writeContract({
    chain: null,
    account,
    address: leg.wrappedNative,
    abi: abis.wegazAbi,
    functionName: 'withdraw',
    args: [wrapped],
  });
  await confirm(leg, publicClient, hash, `unwrap ${wrapped}`, log);
  return hash;
}

async function executeLeg(
  leg: BridgeGasLeg,
  decision: LegDecision,
  treasury: Address,
  { publicClient, walletClient, account }: Clients,
  log: Logger,
): Promise<{ txHashes: Hex[]; nativeReceived: bigint }> {
  if (!walletClient || !account) throw new Error('live run without a signer');
  const txHashes: Hex[] = [];
  const send = async (hash: Hex, label: string) => {
    txHashes.push(hash);
    await confirm(leg, publicClient, hash, label, log);
  };
  const stable = leg.stable as Address;
  const before = await publicClient.getBalance({ address: account.address });

  if (decision.claim > 0n) {
    const hash = await walletClient.writeContract({
      chain: null,
      account,
      address: leg.feeContract as Address,
      abi: FEE_ABI,
      functionName: 'claim',
      args: [account.address],
    });
    await send(hash, `claim ${decision.claim}`);
  }

  if (decision.swap) {
    const { amountIn, minOut } = decision.swap;
    const allowance = await publicClient.readContract({
      address: stable,
      abi: abis.erc20Abi,
      functionName: 'allowance',
      args: [account.address, leg.router],
    });
    if (allowance < amountIn) {
      // Exact-amount approval: the router never holds a standing allowance.
      const hash = await walletClient.writeContract({
        chain: null,
        account,
        address: stable,
        abi: abis.erc20Abi,
        functionName: 'approve',
        args: [leg.router, amountIn],
      });
      await send(hash, 'approve');
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_S);
    const swapHash = await walletClient.writeContract({
      chain: null,
      account,
      address: leg.router,
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, minOut, leg.path, account.address, deadline],
    });
    await send(swapHash, `swap ${amountIn} stable`);

    const wrapped = await publicClient.readContract({
      address: leg.wrappedNative,
      abi: abis.erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (wrapped > 0n) {
      const hash = await walletClient.writeContract({
        chain: null,
        account,
        address: leg.wrappedNative,
        abi: abis.wegazAbi,
        functionName: 'withdraw',
        args: [wrapped],
      });
      await send(hash, `unwrap ${wrapped}`);
    }
  }

  if (decision.sweep > 0n) {
    // Re-read rather than trust the plan: a swap may have spent slightly
    // more/less than quoted. Never sweep below the reserve.
    const held = await publicClient.readContract({
      address: stable,
      abi: abis.erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    const excess = held > leg.reserveStable ? held - leg.reserveStable : 0n;
    const amount = excess < decision.sweep ? excess : decision.sweep;
    if (amount >= leg.minSweep) {
      const hash = await walletClient.writeContract({
        chain: null,
        account,
        address: stable,
        abi: abis.erc20Abi,
        functionName: 'transfer',
        args: [treasury, amount],
      });
      await send(hash, `sweep ${amount} stable to treasury ${treasury}`);
    } else {
      log.info(`[bridge-gas:${leg.name}] sweep skipped: excess ${excess} after swap is below minimum`);
    }
  }

  const after = await publicClient.getBalance({ address: account.address });
  return { txHashes, nativeReceived: after > before ? after - before : 0n };
}

/**
 * Etica only: stipend fresh recipients with EGAZ. Failures here are logged
 * and never fail the leg — gas drops are a courtesy, the bridge does not
 * depend on them.
 */
async function runGasDrops(
  leg: BridgeGasLeg,
  config: BridgeGasConfig,
  { publicClient, walletClient, account }: Clients,
  log: Logger,
): Promise<{ count: number; txHashes: Hex[] }> {
  const cfg = config.gasDrop;
  if (!cfg || !account || leg.name !== 'etica' || !leg.stable) return { count: 0, txHashes: [] };
  const { transfers, fromBlock, toBlock } = await fetchInboundTransfers(publicClient, leg.stable, cfg.lookbackBlocks);
  const unique = [...new Map(transfers.map((t) => [t.recipient.toLowerCase(), t])).values()];
  const balances = new Map<string, bigint>();
  await Promise.all(
    unique.map(async (t) => {
      balances.set(t.recipient.toLowerCase(), await publicClient.getBalance({ address: t.recipient }));
    }),
  );
  const keeperNative = await publicClient.getBalance({ address: account.address });
  const plan = planGasDrops(transfers, balances, account.address, keeperNative, leg.minNative, cfg);
  log.info(
    `[bridge-gas:${leg.name}] gas drop scan blocks ${fromBlock}-${toBlock}: ${transfers.length} inbound, ` +
      `${plan.drops.length} to fund, ${plan.skipped.length} skipped`,
  );
  if (!walletClient) {
    for (const r of plan.drops) log.info(`[bridge-gas:${leg.name}] would send ${cfg.amount} wei to ${r}`);
    return { count: plan.drops.length, txHashes: [] };
  }
  const txHashes: Hex[] = [];
  for (const recipient of plan.drops) {
    const hash = await walletClient.sendTransaction({ chain: null, account, to: recipient, value: cfg.amount });
    txHashes.push(hash);
    await confirm(leg, publicClient, hash, `gas drop ${cfg.amount} -> ${recipient}`, log);
  }
  return { count: txHashes.length, txHashes };
}

export async function runLeg(
  leg: BridgeGasLeg,
  config: BridgeGasConfig,
  log: Logger,
): Promise<LegResult> {
  if (!leg.feeContract || !leg.stable) {
    log.warn(`[bridge-gas:${leg.name}] fee contract / stable not configured; skipping`);
    return { leg: leg.name, status: 'unconfigured', txHashes: [] };
  }
  const clients = makeClients(leg, config);
  if (!clients.account) {
    log.warn(`[bridge-gas:${leg.name}] no keeper key; cannot snapshot the keeper wallet`);
    return { leg: leg.name, status: 'unconfigured', reason: 'no keeper key', txHashes: [] };
  }
  const keeper = clients.account.address;
  const thresholds = {
    minNative: leg.minNative,
    targetNative: leg.targetNative,
    minStable: leg.minStable,
    maxSlippageBps: config.maxSlippageBps,
    reserveStable: leg.reserveStable,
    minSweep: leg.minSweep,
  };
  const txHashes: Hex[] = [];
  try {
    if (!config.dryRun) {
      const unwrapped = await unwrapStranded(leg, clients, log);
      if (unwrapped) txHashes.push(unwrapped);
    }
    const snap = await snapshotLeg(clients.publicClient, leg, keeper);
    const base = {
      leg: leg.name,
      nativeBalance: snap.nativeBalance.toString(),
      feeContractBalance: snap.feeContractBalance.toString(),
      walletStable: snap.walletStable.toString(),
    };
    const shortfall = snap.nativeBalance < leg.minNative ? leg.targetNative - snap.nativeBalance : 0n;
    const quote = shortfall > 0n ? await quoteLeg(clients.publicClient, leg, shortfall) : null;
    const decision = decideLeg(snap, thresholds, quote);
    log.info(
      `[bridge-gas:${leg.name}] native=${snap.nativeBalance} fees=${snap.feeContractBalance} ` +
        `wallet=${snap.walletStable} owns=${snap.keeperOwnsFeeContract} -> claim=${decision.claim} ` +
        `swap=${decision.swap?.amountIn ?? 0n} sweep=${decision.sweep} (${decision.reason})`,
    );
    if (!snap.keeperOwnsFeeContract && snap.feeContractBalance > 0n) {
      log.warn(`[bridge-gas:${leg.name}] keeper is not the fee contract owner; fees cannot be swept`);
    }
    const planned = {
      claimed: decision.claim.toString(),
      swappedIn: (decision.swap?.amountIn ?? 0n).toString(),
      swept: decision.sweep.toString(),
    };
    const hasWork = decision.claim > 0n || decision.swap !== null || decision.sweep > 0n;

    if (config.dryRun) {
      const drops = await runGasDrops(leg, config, clients, log);
      const status = decision.blocked ? 'blocked' : hasWork || drops.count > 0 ? 'planned' : 'idle';
      return { ...base, ...planned, status, gasDrops: drops.count, reason: decision.reason, txHashes };
    }

    let nativeReceived = 0n;
    if (hasWork) {
      const done = await executeLeg(leg, decision, config.treasury, clients, log);
      txHashes.push(...done.txHashes);
      nativeReceived = done.nativeReceived;
    }
    let gasDrops = 0;
    try {
      const drops = await runGasDrops(leg, config, clients, log);
      gasDrops = drops.count;
      txHashes.push(...drops.txHashes);
    } catch (err) {
      log.warn(`[bridge-gas:${leg.name}] gas drop failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    const status = decision.blocked ? 'blocked' : txHashes.length > 0 ? 'executed' : 'idle';
    return {
      ...base,
      ...planned,
      status,
      nativeReceived: nativeReceived.toString(),
      gasDrops,
      reason: decision.reason,
      txHashes,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
    log.error(`[bridge-gas:${leg.name}] ${reason}`);
    return { leg: leg.name, status: 'error', reason, txHashes };
  }
}

export async function runBridgeGas(
  config: BridgeGasConfig,
  opts: { log?: Logger } = {},
): Promise<BridgeGasRunResult> {
  const log = opts.log ?? console;
  const legs: LegResult[] = [];
  for (const leg of config.legs) legs.push(await runLeg(leg, config, log));
  const failures = legs.filter((l) => l.status === 'error' || l.status === 'blocked');
  log.info(
    `[bridge-gas] run complete — ` +
      legs.map((l) => `${l.leg}=${l.status}`).join(' ') +
      ` dryRun=${config.dryRun}`,
  );
  return {
    dryRun: config.dryRun,
    legs,
    ...(failures.length ? { error: failures.map((l) => `${l.leg}: ${l.reason}`).join('; ') } : {}),
  };
}
