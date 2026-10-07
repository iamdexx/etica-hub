/**
 * Bridge seed runner. Everything that can fail is checked before the first
 * transaction (balances, route wiring, pool price against the anchors), and
 * each stage is skipped when its effect already exists on-chain so a
 * re-dispatch resumes wherever the previous run stopped:
 *   0. in flight — a previous run's transfer not delivered yet is waited for,
 *                  never repeated
 *   1. bridge    — Ethereum: approve + transferRemote(USDC -> keeper on Etica)
 *   2. mint      — wait for the relayer to deliver the USDC.e
 *   3. pool      — Etica: approve USDC.e + ETX (+ pair fee), router.addLiquidity
 *                  with `to` = dead address, so the LP is burned as it is minted
 *   4. verify    — pair exists, reserves match, every LP share but the
 *                  factory's MINIMUM_LIQUIDITY sits at the dead address
 * Dry run snapshots, plans and logs without sending anything.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  formatUnits,
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
import { DEAD_ADDRESS, ETICA_DOMAIN, ETX_DECIMALS, STABLE_DECIMALS, type BridgeSeedConfig } from './config.js';
import {
  affordableBridgeAmount,
  bridgeNeeded,
  etxRequired,
  marketUsdPerEtx,
  poolUsdPerEtx,
  priceDeviationBps,
  sum,
  withSlippage,
} from './plan.js';
import { scanInflight } from './inflight.js';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

const WARP_ABI = parseAbi([
  'struct Quote { address token; uint256 amount; }',
  'function wrappedToken() view returns (address)',
  'function mailbox() view returns (address)',
  'function routers(uint32 domain) view returns (bytes32)',
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns (Quote[] quotes)',
  'function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32 messageId)',
]);

/** Uniswap-V2 pairs lock this many LP wei at address(0) on the first mint. */
const MINIMUM_LIQUIDITY = 1_000n;
const DEADLINE_BUFFER_S = 1_200;
const MINT_POLL_MS = 20_000;
/** Below this the bridge is not worth a mainnet tx (and would mint dust). */
const MIN_BRIDGE_STABLE = 1_000_000n;
/** Ethereum gas the keeper must keep for approve + transferRemote at a sane price. */
const ETH_GAS_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

export interface BridgeSeedResult {
  dryRun: boolean;
  /**
   * seeded    pool already live (nothing done) or just created and verified
   * planned   dry run: what a live run would do next
   * waiting   live run bridged (or found a transfer in flight) but the mint did not land in time
   * error     a precondition failed
   */
  status: 'seeded' | 'planned' | 'waiting' | 'error';
  pair?: Address;
  bridged?: string;
  usdce?: string;
  etx?: string;
  pairFee?: string;
  poolUsdPerEtx?: string;
  /** ETX/WEGAZ pool quote x EGAZ/USD anchor. */
  marketUsdPerEtx?: string;
  /** Off-chain ETX/USD anchor, when given. */
  anchorUsdPerEtx?: string;
  /** Largest deviation of the pool price from any anchor. */
  priceDeviationBps?: string;
  inflight?: string;
  deadLp?: string;
  txHashes: Hex[];
  error?: string;
}

interface Clients {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
  account: PrivateKeyAccount | null;
}

function makeClients(
  chain: { id: number; name: string; symbol: string; rpcUrls: string[]; writeRpcUrl: string },
  config: BridgeSeedConfig,
): Clients {
  const def = defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
    rpcUrls: { default: { http: chain.rpcUrls } },
  });
  const readTransport = fallback(
    chain.rpcUrls.map((url) => http(url, { timeout: 15_000, retryCount: 1 })),
    { rank: false },
  );
  const publicClient = createPublicClient({ chain: def, transport: readTransport }) as PublicClient;
  const account = config.privateKey ? privateKeyToAccount(config.privateKey) : null;
  const walletClient =
    account && !config.dryRun ? createWalletClient({ account, chain: def, transport: http(chain.writeRpcUrl) }) : null;
  return { publicClient, walletClient, account };
}

async function confirm(publicClient: PublicClient, hash: Hex, label: string, log: Logger): Promise<void> {
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  log.info(`[bridge-seed] ${label} ${hash}`);
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
  const hash = await walletClient.writeContract({
    chain: null,
    account,
    address: token,
    abi: abis.erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });
  await send(hash, `approve ${amount} of ${token} -> ${spender}`);
}

const lc = (a: string) => a.toLowerCase();

interface PairState {
  address: Address | null;
  reserveUsdce: bigint;
  reserveEtx: bigint;
  creationFee: bigint;
  feeToSet: boolean;
  routerTrusted: boolean;
}

async function readPair(client: PublicClient, config: BridgeSeedConfig): Promise<PairState> {
  const { swapFactory, swapRouter, usdce, etx } = config.etica;
  const [pairAddr, creationFee, feeTo, routerTrusted, factoryEtx] = await Promise.all([
    client.readContract({ address: swapFactory, abi: abis.factoryAbi, functionName: 'getPair', args: [usdce, etx] }),
    client.readContract({ address: swapFactory, abi: abis.factoryAbi, functionName: 'pairCreationFee' }),
    client.readContract({ address: swapFactory, abi: abis.factoryAbi, functionName: 'feeTo' }),
    client.readContract({ address: swapFactory, abi: abis.factoryAbi, functionName: 'trustedCreators', args: [swapRouter] }),
    client.readContract({ address: swapFactory, abi: abis.factoryAbi, functionName: 'etx' }),
  ]);
  if (lc(factoryEtx) !== lc(etx)) throw new Error(`factory.etx() is ${factoryEtx}, expected ${etx}`);
  const zero = lc(pairAddr) === lc('0x0000000000000000000000000000000000000000');
  let reserveUsdce = 0n;
  let reserveEtx = 0n;
  if (!zero) {
    const [token0, reserves] = await Promise.all([
      client.readContract({ address: pairAddr, abi: abis.pairAbi, functionName: 'token0' }),
      client.readContract({ address: pairAddr, abi: abis.pairAbi, functionName: 'getReserves' }),
    ]);
    [reserveUsdce, reserveEtx] = lc(token0) === lc(usdce) ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];
  }
  return {
    address: zero ? null : pairAddr,
    reserveUsdce,
    reserveEtx,
    creationFee,
    feeToSet: lc(feeTo) !== lc('0x0000000000000000000000000000000000000000'),
    routerTrusted,
  };
}

async function quoteBridge(
  client: PublicClient,
  config: BridgeSeedConfig,
  recipient: Hex,
  amount: bigint,
): Promise<{ native: bigint; tokenFee: bigint }> {
  const quotes = await client.readContract({
    address: config.ethereum.warpRouter,
    abi: WARP_ABI,
    functionName: 'quoteTransferRemote',
    args: [ETICA_DOMAIN, recipient, amount],
  });
  let native = 0n;
  let stableTotal = 0n;
  for (const q of quotes) {
    if (lc(q.token) === lc('0x0000000000000000000000000000000000000000')) native += q.amount;
    else if (lc(q.token) === lc(config.ethereum.usdc)) stableTotal += q.amount;
    else if (q.amount > 0n) throw new Error(`warp router quotes a fee in unexpected token ${q.token}`);
  }
  if (stableTotal < amount) throw new Error(`warp router quotes ${stableTotal} USDC for a ${amount} transfer`);
  return { native, tokenFee: stableTotal - amount };
}

/** The collateral router must be the one wired to the canonical mailbox and to our USDC.e on Etica. */
async function verifyWarpRoute(client: PublicClient, config: BridgeSeedConfig): Promise<void> {
  const router = config.ethereum.warpRouter;
  const [wrapped, mailbox, remote] = await Promise.all([
    client.readContract({ address: router, abi: WARP_ABI, functionName: 'wrappedToken' }),
    client.readContract({ address: router, abi: WARP_ABI, functionName: 'mailbox' }),
    client.readContract({ address: router, abi: WARP_ABI, functionName: 'routers', args: [ETICA_DOMAIN] }),
  ]);
  if (lc(wrapped) !== lc(config.ethereum.usdc)) throw new Error(`warp router wraps ${wrapped}, expected USDC`);
  if (lc(mailbox) !== lc(config.ethereum.mailbox)) throw new Error(`warp router mailbox is ${mailbox}, expected ${config.ethereum.mailbox}`);
  const expectedRemote = pad(config.etica.usdce, { size: 32 });
  if (lc(remote) !== lc(expectedRemote)) throw new Error(`warp router's Etica counterpart is ${remote}, expected ${expectedRemote}`);
}

async function usdceBalance(client: PublicClient, config: BridgeSeedConfig, who: Address): Promise<bigint> {
  return client.readContract({ address: config.etica.usdce, abi: abis.erc20Abi, functionName: 'balanceOf', args: [who] });
}

async function waitForMint(
  client: PublicClient,
  config: BridgeSeedConfig,
  who: Address,
  atLeast: bigint,
  log: Logger,
  sleep: (ms: number) => Promise<void>,
): Promise<bigint> {
  const deadline = Date.now() + config.mintTimeoutMs;
  for (;;) {
    const bal = await usdceBalance(client, config, who);
    if (bal >= atLeast) return bal;
    if (Date.now() >= deadline) return bal;
    log.info(`[bridge-seed] waiting for USDC.e mint: ${formatUnits(bal, STABLE_DECIMALS)} / ${formatUnits(atLeast, STABLE_DECIMALS)}`);
    await sleep(MINT_POLL_MS);
  }
}

async function lpState(client: PublicClient, pair: Address): Promise<{ deadLp: bigint; totalLp: bigint }> {
  const [deadLp, totalLp] = await Promise.all([
    client.readContract({ address: pair, abi: abis.erc20Abi, functionName: 'balanceOf', args: [DEAD_ADDRESS] }),
    client.readContract({ address: pair, abi: abis.pairAbi, functionName: 'totalSupply' }),
  ]);
  return { deadLp, totalLp };
}

export async function runBridgeSeed(
  config: BridgeSeedConfig,
  opts: { log?: Logger; sleep?: (ms: number) => Promise<void> } = {},
): Promise<BridgeSeedResult> {
  const log = opts.log ?? console;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const txHashes: Hex[] = [];
  const dryRun = config.dryRun;
  const eth = makeClients(
    { id: config.ethereum.chainId, name: 'ethereum', symbol: 'ETH', rpcUrls: config.ethereum.rpcUrls, writeRpcUrl: config.ethereum.writeRpcUrl },
    config,
  );
  const eti = makeClients(
    { id: config.etica.chainId, name: 'etica', symbol: 'EGAZ', rpcUrls: config.etica.rpcUrls, writeRpcUrl: config.etica.rpcUrls[0]! },
    config,
  );
  const account = eth.account;
  if (!account) return { dryRun, status: 'error', txHashes, error: 'no signer key: set HARVEST_PRIVATE_KEY (a dry run still needs the address)' };
  const keeper = account.address;
  const fmtStable = (v: bigint) => formatUnits(v, STABLE_DECIMALS);
  const fmtEtx = (v: bigint) => formatUnits(v, ETX_DECIMALS);

  try {
    // ---- snapshot --------------------------------------------------------
    const pair = await readPair(eti.publicClient, config);
    if (pair.address && pair.reserveUsdce > 0n && pair.reserveEtx > 0n) {
      const { deadLp, totalLp } = await lpState(eti.publicClient, pair.address);
      const summary = {
        dryRun,
        pair: pair.address,
        usdce: pair.reserveUsdce.toString(),
        etx: pair.reserveEtx.toString(),
        poolUsdPerEtx: formatUnits(poolUsdPerEtx(pair.reserveUsdce, STABLE_DECIMALS, pair.reserveEtx), 18),
        deadLp: deadLp.toString(),
        txHashes,
      };
      if (deadLp === 0n) {
        return {
          ...summary,
          status: 'error',
          error: `pair ${pair.address} already holds ${fmtStable(pair.reserveUsdce)} USDC.e / ${fmtEtx(pair.reserveEtx)} ETX with no LP at the dead address: someone else opened it, refusing to add to a pool whose liquidity can be withdrawn`,
        };
      }
      if (deadLp + MINIMUM_LIQUIDITY < totalLp) {
        log.warn(`[bridge-seed] dead address holds ${deadLp} of ${totalLp} LP (someone else also provided liquidity)`);
      }
      log.info(`[bridge-seed] pool already live at ${pair.address}: ${fmtStable(pair.reserveUsdce)} USDC.e / ${fmtEtx(pair.reserveEtx)} ETX, ${deadLp} LP burned`);
      return { ...summary, status: 'seeded' };
    }

    const [ethUsdc, ethNative, eticaUsdce, eticaEtx] = await Promise.all([
      eth.publicClient.readContract({ address: config.ethereum.usdc, abi: abis.erc20Abi, functionName: 'balanceOf', args: [keeper] }),
      eth.publicClient.getBalance({ address: keeper }),
      usdceBalance(eti.publicClient, config, keeper),
      eti.publicClient.readContract({ address: config.etica.etx, abi: abis.erc20Abi, functionName: 'balanceOf', args: [keeper] }),
    ]);
    log.info(
      `[bridge-seed] keeper ${keeper}: ${fmtStable(ethUsdc)} USDC + ${formatUnits(ethNative, 18)} ETH on Ethereum; ` +
        `${fmtStable(eticaUsdce)} USDC.e + ${fmtEtx(eticaEtx)} ETX on Etica; pair ${pair.address ?? 'not created'}`,
    );

    // ETX side is checked first so a run never bridges USDC it then cannot pool.
    const etxNeeded = etxRequired(config.etxAmount, { exists: pair.address !== null, creationFee: pair.creationFee, feeToSet: pair.feeToSet, routerTrusted: pair.routerTrusted });
    const pairFee = etxNeeded - config.etxAmount;
    if (eticaEtx < etxNeeded) {
      return {
        dryRun,
        status: 'error',
        txHashes,
        etx: config.etxAmount.toString(),
        pairFee: pairFee.toString(),
        error: `keeper holds ${fmtEtx(eticaEtx)} ETX, needs ${fmtEtx(etxNeeded)} (${fmtEtx(config.etxAmount)} pool + ${fmtEtx(pairFee)} pair fee)`,
      };
    }

    // ---- stage 0: transfers still in flight -------------------------------
    const flight = await scanInflight(eth.publicClient, eti.publicClient, config, keeper);
    const inflight = sum(flight.pending);
    log.info(
      `[bridge-seed] in-flight scan: Ethereum ${flight.ethereumBlocks.from}-${flight.ethereumBlocks.to} sent ${flight.sent.length}, ` +
        `Etica ${flight.eticaBlocks.from}-${flight.eticaBlocks.to} received ${flight.received.length}, pending ${flight.pending.length} (${fmtStable(inflight)} USDC)`,
    );

    // ---- stage 1 plan: bridge --------------------------------------------
    const need = bridgeNeeded(config.usdcAmount, ethUsdc, eticaUsdce, inflight);
    const recipient = pad(keeper, { size: 32 });
    let amount = 0n;
    let native = 0n;
    let tokenFee = 0n;
    if (need > 0n) {
      if (need < MIN_BRIDGE_STABLE) {
        return { dryRun, status: 'error', txHashes, error: `only ${fmtStable(need)} USDC left to bridge, below the ${fmtStable(MIN_BRIDGE_STABLE)} minimum` };
      }
      await verifyWarpRoute(eth.publicClient, config);
      // amount + fee(amount) must fit the balance; the fee quoted at `need` is an upper bound.
      const upper = await quoteBridge(eth.publicClient, config, recipient, need);
      if (config.usdcAmount === null) {
        amount = affordableBridgeAmount(need, upper.tokenFee);
      } else if (need + upper.tokenFee <= ethUsdc) {
        amount = need;
      } else {
        return {
          dryRun,
          status: 'error',
          txHashes,
          error: `keeper holds ${fmtStable(ethUsdc)} USDC, needs ${fmtStable(need + upper.tokenFee)} (${fmtStable(need)} + ${fmtStable(upper.tokenFee)} bridge fee) to reach the requested ${fmtStable(config.usdcAmount)} USDC.e`,
        };
      }
      if (amount < MIN_BRIDGE_STABLE) {
        return { dryRun, status: 'error', txHashes, error: `USDC ${fmtStable(ethUsdc)} does not cover the bridge fee ${fmtStable(upper.tokenFee)}` };
      }
      ({ native, tokenFee } = await quoteBridge(eth.publicClient, config, recipient, amount));
      if (ethNative < native + ETH_GAS_RESERVE_WEI) {
        return { dryRun, status: 'error', txHashes, error: `keeper has ${formatUnits(ethNative, 18)} ETH, needs ${formatUnits(native, 18)} delivery payment + gas` };
      }
      log.info(`[bridge-seed] bridge ${fmtStable(amount)} USDC -> ${keeper} on Etica (fee ${fmtStable(tokenFee)} USDC, gas payment ${native} wei)`);
    }
    // USDC.e the keeper will hold once everything sent has landed.
    const target = eticaUsdce + inflight + amount;
    let usdceForPool = target;
    if (config.usdcAmount !== null) {
      if (target < config.usdcAmount) {
        return {
          dryRun,
          status: 'error',
          txHashes,
          error: `${fmtStable(eticaUsdce)} USDC.e + ${fmtStable(inflight)} in flight + ${fmtStable(amount)} bridgeable is short of the requested ${fmtStable(config.usdcAmount)} USDC.e (${fmtStable(ethUsdc)} USDC on Ethereum)`,
        };
      }
      usdceForPool = config.usdcAmount;
    }
    if (usdceForPool < MIN_BRIDGE_STABLE) {
      return { dryRun, status: 'error', txHashes, error: `nothing to pool: ${fmtStable(ethUsdc)} USDC on Ethereum, ${fmtStable(eticaUsdce)} USDC.e on Etica` };
    }

    // ---- price sanity (before any tx) ------------------------------------
    const pool = poolUsdPerEtx(usdceForPool, STABLE_DECIMALS, config.etxAmount);
    const result: BridgeSeedResult = {
      dryRun,
      status: 'planned',
      txHashes,
      bridged: amount.toString(),
      inflight: inflight.toString(),
      usdce: usdceForPool.toString(),
      etx: config.etxAmount.toString(),
      pairFee: pairFee.toString(),
      poolUsdPerEtx: formatUnits(pool, 18),
    };
    const anchors: { label: string; price: bigint }[] = [];
    if (config.egazUsd !== null) {
      const amounts = await eti.publicClient.readContract({
        address: config.etica.swapRouter,
        abi: abis.routerAbi,
        functionName: 'getAmountsOut',
        args: [10n ** 18n, [config.etica.etx, config.etica.wegaz]],
      });
      const market = marketUsdPerEtx(amounts[amounts.length - 1]!, config.egazUsd);
      result.marketUsdPerEtx = formatUnits(market, 18);
      anchors.push({ label: 'ETX/WEGAZ pool x EGAZ/USD', price: market });
    }
    if (config.etxUsd !== null) {
      result.anchorUsdPerEtx = formatUnits(config.etxUsd, 18);
      anchors.push({ label: 'ETX/USD anchor', price: config.etxUsd });
    }
    if (anchors.length === 0) {
      if (!dryRun) return { ...result, status: 'error', error: 'a live run needs a price anchor: set BRIDGE_SEED_EGAZ_USD and/or BRIDGE_SEED_ETX_USD' };
      log.warn('[bridge-seed] no price anchor set: skipping the market-price check (a live run refuses without one)');
    }
    let worst = 0n;
    for (const anchor of anchors) {
      const deviation = priceDeviationBps(pool, anchor.price);
      if (deviation === null || deviation > BigInt(config.maxPriceDeviationBps)) {
        return {
          ...result,
          priceDeviationBps: deviation?.toString(),
          status: 'error',
          error: `pool price ${result.poolUsdPerEtx} USD/ETX is ${deviation ?? '∞'} bps off the ${anchor.label} ${formatUnits(anchor.price, 18)} (max ${config.maxPriceDeviationBps})`,
        };
      }
      if (deviation > worst) worst = deviation;
    }
    if (anchors.length > 0) result.priceDeviationBps = worst.toString();
    log.info(
      `[bridge-seed] pool: ${fmtStable(usdceForPool)} USDC.e + ${fmtEtx(config.etxAmount)} ETX (${result.poolUsdPerEtx} USD/ETX` +
        anchors.map((a) => `, ${a.label} ${formatUnits(a.price, 18)}`).join('') +
        `${anchors.length > 0 ? `, worst Δ ${result.priceDeviationBps} bps` : ''}), pair fee ${fmtEtx(pairFee)} ETX, LP -> ${DEAD_ADDRESS}`,
    );
    if (!eth.walletClient || !eti.walletClient) return result;

    // ---- stage 1: bridge --------------------------------------------------
    if (amount > 0n) {
      const send = async (hash: Hex, label: string) => {
        txHashes.push(hash);
        await confirm(eth.publicClient, hash, label, log);
      };
      await approveExact(config.ethereum.usdc, config.ethereum.warpRouter, amount + tokenFee, eth, send);
      const hash = await eth.walletClient.writeContract({
        chain: null,
        account,
        address: config.ethereum.warpRouter,
        abi: WARP_ABI,
        functionName: 'transferRemote',
        args: [ETICA_DOMAIN, recipient, amount],
        value: native,
      });
      await send(hash, `transferRemote ${fmtStable(amount)} USDC -> Etica`);
    }

    // ---- stage 2: mint ----------------------------------------------------
    if (amount > 0n || inflight > 0n) {
      const bal = await waitForMint(eti.publicClient, config, keeper, target, log, sleep);
      if (bal < target) {
        return {
          ...result,
          status: 'waiting',
          error: `USDC.e mint not seen within ${config.mintTimeoutMs / 1000}s (balance ${fmtStable(bal)} / ${fmtStable(target)}); re-dispatch to resume`,
        };
      }
    }

    // ---- stage 3: pool ---------------------------------------------------
    const send = async (hash: Hex, label: string) => {
      txHashes.push(hash);
      await confirm(eti.publicClient, hash, label, log);
    };
    await approveExact(config.etica.usdce, config.etica.swapRouter, usdceForPool, eti, send);
    await approveExact(config.etica.etx, config.etica.swapRouter, etxNeeded, eti, send);
    const block = await eti.publicClient.getBlock();
    const hash = await eti.walletClient.writeContract({
      chain: null,
      account,
      address: config.etica.swapRouter,
      abi: abis.routerAbi,
      functionName: 'addLiquidity',
      args: [
        config.etica.usdce,
        config.etica.etx,
        usdceForPool,
        config.etxAmount,
        withSlippage(usdceForPool, config.liquiditySlippageBps),
        withSlippage(config.etxAmount, config.liquiditySlippageBps),
        DEAD_ADDRESS,
        block.timestamp + BigInt(DEADLINE_BUFFER_S),
      ],
    });
    await send(hash, 'addLiquidity(USDC.e, ETX) -> dead address');

    // ---- stage 4: verify -------------------------------------------------
    const after = await readPair(eti.publicClient, config);
    if (!after.address) throw new Error('addLiquidity confirmed but factory.getPair is still zero');
    const { deadLp, totalLp } = await lpState(eti.publicClient, after.address);
    if (deadLp === 0n) throw new Error(`pair ${after.address} minted no LP to the dead address`);
    if (deadLp + MINIMUM_LIQUIDITY < totalLp) {
      log.warn(`[bridge-seed] dead address holds ${deadLp} of ${totalLp} LP (someone else also provided liquidity)`);
    }
    log.info(`[bridge-seed] pool ${after.address} live: ${fmtStable(after.reserveUsdce)} USDC.e / ${fmtEtx(after.reserveEtx)} ETX; ${deadLp} LP burned`);
    return { ...result, status: 'seeded', pair: after.address, usdce: after.reserveUsdce.toString(), etx: after.reserveEtx.toString(), deadLp: deadLp.toString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[bridge-seed] ${msg}`);
    return { dryRun, status: 'error', txHashes, error: msg };
  }
}
