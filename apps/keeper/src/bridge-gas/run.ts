/**
 * Bridge gas runner — snapshots each leg, lets `plan.ts` decide, and
 * either logs (dry-run) or submits, in order: claim(keeper) on the fee
 * contract, approve + swapExactTokensForTokens(stable -> ... -> wrapped
 * native) + wrapped.withdraw(), then the surplus: on Etica swap a bounded
 * chunk of it along the same path and keep the EGAZ; on Ethereum
 * transferRemote() the USDC to the keeper's own Etica wallet so the next run
 * swaps it there. Finally, on Etica, the recipient gas drops. Every send goes through `leg.writeRpcUrl`
 * (Flashbots Protect on Ethereum); reads fail over across `leg.rpcUrls`.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  pad,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { abis } from '@etica-hub/shared';
import { ETICA_DOMAIN, type BridgeGasConfig, type BridgeGasLeg } from './config.js';
import { fetchInboundTransfers, planGasDrops } from './gas-drop.js';
import { decideLeg, planSurplusSwap, type LegDecision, type LegSnapshot, type SwapPlan, type SwapQuote } from './plan.js';

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

/** Hyperlane HypERC20Collateral (TokenRouter + MailboxClient) surface the keeper relies on. */
const WARP_ABI = parseAbi([
  'struct Quote { address token; uint256 amount; }',
  'function wrappedToken() view returns (address)',
  'function mailbox() view returns (address)',
  'function routers(uint32 domain) view returns (bytes32)',
  'function feeRecipient() view returns (address)',
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns (Quote[] quotes)',
  'function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32 messageId)',
]);

const DEADLINE_BUFFER_S = 300;

export interface LegResult {
  leg: BridgeGasLeg['name'];
  /**
   * idle      nothing to do
   * executed  at least one tx sent (claim / swap / burn / bridge / gas drop)
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
  /** Stable released from the wallet this run and where it went. */
  surplus?: string;
  surplusTo?: 'swap-to-native' | 'bridge-to-etica' | 'held';
  /** Why the surplus was held instead (thin pool, router unset / failed verification). */
  surplusBlocked?: string;
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
    rpcUrls: { default: { http: leg.rpcUrls } },
  });
  // Ordered failover, not latency-ranked: the configured endpoint stays first
  // and a rate-limited or dead public node just hands the call to the next.
  const readTransport = fallback(
    leg.rpcUrls.map((url) => http(url, { timeout: 15_000, retryCount: 1 })),
    { rank: false },
  );
  const publicClient = createPublicClient({ chain, transport: readTransport }) as PublicClient;
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

  const after = await publicClient.getBalance({ address: account.address });
  return { txHashes, nativeReceived: after > before ? after - before : 0n };
}

async function approveExact(
  token: Address,
  spender: Address,
  amount: bigint,
  { publicClient, walletClient, account }: Clients,
  send: (hash: Hex, label: string) => Promise<void>,
): Promise<void> {
  if (!walletClient || !account) throw new Error('live run without a signer');
  const allowance = await publicClient.readContract({
    address: token,
    abi: abis.erc20Abi,
    functionName: 'allowance',
    args: [account.address, spender],
  });
  if (allowance >= amount) return;
  // Exact-amount approval: the spender never holds a standing allowance.
  const hash = await walletClient.writeContract({
    chain: null,
    account,
    address: token,
    abi: abis.erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });
  await send(hash, `approve ${amount} -> ${spender}`);
}

/** Stable actually above the reserve right now, capped at what the plan released. */
async function releasable(
  leg: BridgeGasLeg,
  planned: bigint,
  publicClient: PublicClient,
  keeper: Address,
): Promise<bigint> {
  const held = await publicClient.readContract({
    address: leg.stable as Address,
    abi: abis.erc20Abi,
    functionName: 'balanceOf',
    args: [keeper],
  });
  const excess = held > leg.reserveStable ? held - leg.reserveStable : 0n;
  const amount = excess < planned ? excess : planned;
  return amount >= leg.minSweep ? amount : 0n;
}

/** Quote `amountIn` stable along the leg's path plus a one-unit probe for the marginal price. */
export async function quoteSurplus(client: PublicClient, leg: BridgeGasLeg, amountIn: bigint): Promise<SwapQuote | null> {
  const probeIn = 10n ** BigInt(leg.stableDecimals);
  try {
    const [amounts, probe] = await Promise.all([
      client.readContract({ address: leg.router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, leg.path] }),
      client.readContract({ address: leg.router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [probeIn, leg.path] }),
    ]);
    const amountOut = amounts[amounts.length - 1];
    const probeOut = probe[probe.length - 1];
    if (amountOut === undefined || probeOut === undefined) return null;
    return { amountIn, amountOut, probeIn, probeOut };
  } catch {
    return null;
  }
}

/**
 * Largest chunk of `surplus` (<= maxChunk, halving down to minSweep) whose
 * swap clears the price-impact ceiling; `blocked` carries the last reason.
 */
export async function planSurplusChunk(
  client: PublicClient,
  leg: BridgeGasLeg,
  surplus: bigint,
  maxSlippageBps: number,
): Promise<{ plan: SwapPlan | null; blocked: string | null }> {
  if (leg.surplus.kind !== 'swap-to-native') return { plan: null, blocked: null };
  let chunk = surplus > leg.surplus.maxChunk ? leg.surplus.maxChunk : surplus;
  if (chunk < leg.minSweep) return { plan: null, blocked: 'surplus chunk below minimum' };
  for (;;) {
    const last = planSurplusSwap(chunk, chunk, leg.minSweep, await quoteSurplus(client, leg, chunk), maxSlippageBps);
    if (last.plan || !last.blocked?.includes('price impact')) return last;
    const half = chunk / 2n;
    if (half >= leg.minSweep) chunk = half;
    else if (chunk > leg.minSweep) chunk = leg.minSweep;
    else return last;
  }
}

/**
 * Etica: swap a bounded chunk of the surplus to EGAZ along the pinned path
 * and keep it in the keeper wallet — no target, the EGAZ just accumulates.
 * Returns the stable released, or 0 with a reason when held.
 */
async function executeSurplusSwap(
  leg: BridgeGasLeg,
  planned: bigint,
  maxSlippageBps: number,
  clients: Clients,
  send: (hash: Hex, label: string) => Promise<void>,
  log: Logger,
): Promise<{ released: bigint; blocked: string | null }> {
  const { publicClient, walletClient, account } = clients;
  if (!walletClient || !account || leg.surplus.kind !== 'swap-to-native') throw new Error('live run without a signer');
  const stable = leg.stable as Address;
  const amount = await releasable(leg, planned, publicClient, account.address);
  if (amount === 0n) return { released: 0n, blocked: 'surplus below minimum after swap' };
  const { plan, blocked } = await planSurplusChunk(publicClient, leg, amount, maxSlippageBps);
  if (!plan) return { released: 0n, blocked };

  await approveExact(stable, leg.router, plan.amountIn, clients, send);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_S);
  const swapHash = await walletClient.writeContract({
    chain: null,
    account,
    address: leg.router,
    abi: ROUTER_ABI,
    functionName: 'swapExactTokensForTokens',
    args: [plan.amountIn, plan.minOut, leg.path, account.address, deadline],
  });
  await send(swapHash, `surplus swap ${plan.amountIn} stable -> ${leg.nativeSymbol}`);
  const wrapped = await publicClient.readContract({ address: leg.wrappedNative, abi: abis.erc20Abi, functionName: 'balanceOf', args: [account.address] });
  if (wrapped > 0n) {
    const hash = await walletClient.writeContract({ chain: null, account, address: leg.wrappedNative, abi: abis.wegazAbi, functionName: 'withdraw', args: [wrapped] });
    await send(hash, `unwrap ${wrapped}`);
  }
  log.info(`[bridge-gas:${leg.name}] swapped ${plan.amountIn} stable into ${leg.nativeSymbol} for the keeper`);
  return { released: plan.amountIn, blocked: null };
}

/**
 * Ethereum: bridge the surplus USDC to the keeper's own address on Etica
 * through the collateral router, so it lands as USDC.e and is swapped to
 * EGAZ on the next Etica run. The router is verified on-chain first — it
 * must wrap this leg's USDC, hang off the canonical Mailbox, route Etica to
 * the configured USDC.e and forward fees to the configured fee contract —
 * so a poisoned `BRIDGE_GAS_ETHEREUM_WARP_ROUTER` cannot be a sink.
 */
async function executeBridgeToEtica(
  leg: BridgeGasLeg,
  planned: bigint,
  config: BridgeGasConfig,
  clients: Clients,
  send: (hash: Hex, label: string) => Promise<void>,
  log: Logger,
): Promise<{ released: bigint; blocked: string | null }> {
  const { publicClient, walletClient, account } = clients;
  if (!walletClient || !account || leg.surplus.kind !== 'bridge-to-etica') throw new Error('live run without a signer');
  const router = leg.surplus.warpRouter;
  if (!router) return { released: 0n, blocked: 'BRIDGE_GAS_ETHEREUM_WARP_ROUTER not set' };
  const stable = leg.stable as Address;
  const eticaStable = config.legs.find((l) => l.name === 'etica')?.stable ?? null;
  if (!eticaStable) return { released: 0n, blocked: 'Etica USDC.e not configured; cannot verify the route' };

  const [wrapped, mailbox, remote, feeRecipient] = await Promise.all([
    publicClient.readContract({ address: router, abi: WARP_ABI, functionName: 'wrappedToken' }),
    publicClient.readContract({ address: router, abi: WARP_ABI, functionName: 'mailbox' }),
    publicClient.readContract({ address: router, abi: WARP_ABI, functionName: 'routers', args: [ETICA_DOMAIN] }),
    publicClient.readContract({ address: router, abi: WARP_ABI, functionName: 'feeRecipient' }),
  ]);
  const lc = (a: string) => a.toLowerCase();
  if (lc(wrapped) !== lc(stable)) throw new Error(`warp router ${router} wraps ${wrapped}, not ${stable}`);
  if (lc(mailbox) !== lc(config.ethereumMailbox)) throw new Error(`warp router ${router} uses mailbox ${mailbox}, expected ${config.ethereumMailbox}`);
  if (lc(remote) !== lc(pad(eticaStable, { size: 32 }))) throw new Error(`warp router ${router} routes Etica to ${remote}, expected ${eticaStable}`);
  if (lc(feeRecipient) !== lc(leg.feeContract as Address)) throw new Error(`warp router ${router} pays fees to ${feeRecipient}, not ${leg.feeContract}`);

  const available = await releasable(leg, planned, publicClient, account.address);
  if (available === 0n) return { released: 0n, blocked: 'surplus below minimum after swap' };
  const recipient = pad(account.address, { size: 32 });
  // The router pulls amount + fee and quotes the stable leg as that total;
  // fee is monotonic in amount, so quoting at `available` over-estimates and
  // amount + fee(amount) <= available.
  const quoteAt = async (amt: bigint) => {
    const quotes = await publicClient.readContract({ address: router, abi: WARP_ABI, functionName: 'quoteTransferRemote', args: [ETICA_DOMAIN, recipient, amt] });
    let native = 0n;
    let stableTotal = 0n;
    for (const q of quotes) {
      if (lc(q.token) === '0x0000000000000000000000000000000000000000') native += q.amount;
      else if (lc(q.token) === lc(stable)) stableTotal += q.amount;
      else if (q.amount > 0n) throw new Error(`warp router quotes a fee in unexpected token ${q.token}`);
    }
    if (stableTotal < amt) throw new Error(`warp router quotes ${stableTotal} stable for a ${amt} transfer`);
    return { native, tokenFee: stableTotal - amt };
  };
  const upper = await quoteAt(available);
  const amount = available - upper.tokenFee;
  if (amount < leg.minSweep) return { released: 0n, blocked: `surplus ${available} does not cover the bridge fee ${upper.tokenFee}` };
  const { native, tokenFee } = await quoteAt(amount);
  const nativeBalance = await publicClient.getBalance({ address: account.address });
  if (nativeBalance - native < leg.minNative) {
    return { released: 0n, blocked: `bridging needs ${native} wei of gas payment; keeper would drop below its floor` };
  }

  await approveExact(stable, router, amount + tokenFee, clients, send);
  const hash = await walletClient.writeContract({
    chain: null,
    account,
    address: router,
    abi: WARP_ABI,
    functionName: 'transferRemote',
    args: [ETICA_DOMAIN, recipient, amount],
    value: native,
  });
  await send(hash, `bridge ${amount} USDC -> keeper on Etica (fee ${tokenFee}, gas payment ${native} wei)`);
  log.info(`[bridge-gas:${leg.name}] bridged ${amount} stable to Etica to be swapped to EGAZ`);
  return { released: amount + tokenFee, blocked: null };
}

async function executeSurplus(
  leg: BridgeGasLeg,
  decision: LegDecision,
  config: BridgeGasConfig,
  clients: Clients,
  log: Logger,
): Promise<{ txHashes: Hex[]; released: bigint; blocked: string | null }> {
  const txHashes: Hex[] = [];
  const send = async (hash: Hex, label: string) => {
    txHashes.push(hash);
    await confirm(leg, clients.publicClient, hash, label, log);
  };
  if (decision.surplus === 0n) return { txHashes, released: 0n, blocked: null };
  const out =
    leg.surplus.kind === 'swap-to-native'
      ? await executeSurplusSwap(leg, decision.surplus, config.maxSlippageBps, clients, send, log)
      : await executeBridgeToEtica(leg, decision.surplus, config, clients, send, log);
  if (out.blocked) log.warn(`[bridge-gas:${leg.name}] surplus ${decision.surplus} held: ${out.blocked}`);
  return { txHashes, ...out };
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
        `swap=${decision.swap?.amountIn ?? 0n} surplus=${decision.surplus}->${leg.surplus.kind} (${decision.reason})`,
    );
    if (!snap.keeperOwnsFeeContract && snap.feeContractBalance > 0n) {
      log.warn(`[bridge-gas:${leg.name}] keeper is not the fee contract owner; fees cannot be swept`);
    }
    const planned = {
      claimed: decision.claim.toString(),
      swappedIn: (decision.swap?.amountIn ?? 0n).toString(),
      surplus: decision.surplus.toString(),
      surplusTo: leg.surplus.kind,
    };
    const hasWork = decision.claim > 0n || decision.swap !== null || decision.surplus > 0n;

    if (config.dryRun) {
      if (decision.surplus > 0n && leg.surplus.kind === 'swap-to-native') {
        const { plan, blocked } = await planSurplusChunk(clients.publicClient, leg, decision.surplus, config.maxSlippageBps);
        log.info(
          plan
            ? `[bridge-gas:${leg.name}] would swap ${plan.amountIn} of ${decision.surplus} USDC.e surplus -> >=${plan.minOut} ${leg.nativeSymbol} for the keeper`
            : `[bridge-gas:${leg.name}] would hold surplus ${decision.surplus}: ${blocked}`,
        );
      } else if (decision.surplus > 0n) {
        log.info(`[bridge-gas:${leg.name}] would bridge ${decision.surplus} USDC to the keeper on Etica to be swapped to EGAZ`);
      }
      const drops = await runGasDrops(leg, config, clients, log);
      const status = decision.blocked ? 'blocked' : hasWork || drops.count > 0 ? 'planned' : 'idle';
      return { ...base, ...planned, status, gasDrops: drops.count, reason: decision.reason, txHashes };
    }

    let nativeReceived = 0n;
    if (hasWork) {
      const done = await executeLeg(leg, decision, clients, log);
      txHashes.push(...done.txHashes);
      nativeReceived = done.nativeReceived;
      const sur = await executeSurplus(leg, decision, config, clients, log);
      txHashes.push(...sur.txHashes);
      planned.surplus = sur.released.toString();
      if (sur.blocked) Object.assign(planned, { surplusTo: 'held' as const, surplusBlocked: sur.blocked });
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
