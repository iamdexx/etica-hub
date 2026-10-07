/**
 * Bridge seed runner. Stages, each skipped when already done so a
 * re-dispatch resumes wherever the previous run stopped:
 *   1. bridge   — Ethereum: approve + transferRemote(USDC -> keeper on Etica)
 *   2. mint     — wait for the relayer to deliver the USDC.e
 *   3. pool     — Etica: approve USDC.e + ETX (+ pair fee), router.addLiquidity
 *                 with `to` = dead address, so the LP is burned as it is minted
 *   4. verify   — pair exists, reserves match, every LP share but the
 *                 factory's MINIMUM_LIQUIDITY sits at the dead address
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
  etxRequired,
  marketUsdPerEtx,
  poolUsdPerEtx,
  priceDeviationBps,
  withSlippage,
} from './plan.js';

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
   * waiting   live run bridged / found USDC in flight but the mint did not land in time
   * error     a precondition failed
   */
  status: 'seeded' | 'planned' | 'waiting' | 'error';
  pair?: Address;
  bridged?: string;
  usdce?: string;
  etx?: string;
  pairFee?: string;
  poolUsdPerEtx?: string;
  marketUsdPerEtx?: string;
  priceDeviationBps?: string;
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

  try {
    // ---- snapshot --------------------------------------------------------
    const pair = await readPair(eti.publicClient, config);
    if (pair.address && pair.reserveUsdce > 0n && pair.reserveEtx > 0n) {
      const deadLp = await eti.publicClient.readContract({ address: pair.address, abi: abis.erc20Abi, functionName: 'balanceOf', args: [DEAD_ADDRESS] });
      log.info(`[bridge-seed] pool already live at ${pair.address}: ${formatUnits(pair.reserveUsdce, STABLE_DECIMALS)} USDC.e / ${formatUnits(pair.reserveEtx, ETX_DECIMALS)} ETX`);
      return {
        dryRun,
        status: 'seeded',
        pair: pair.address,
        usdce: pair.reserveUsdce.toString(),
        etx: pair.reserveEtx.toString(),
        poolUsdPerEtx: formatUnits(poolUsdPerEtx(pair.reserveUsdce, STABLE_DECIMALS, pair.reserveEtx), 18),
        deadLp: deadLp.toString(),
        txHashes,
      };
    }

    const [ethUsdc, ethNative, eticaUsdce, eticaEtx] = await Promise.all([
      eth.publicClient.readContract({ address: config.ethereum.usdc, abi: abis.erc20Abi, functionName: 'balanceOf', args: [keeper] }),
      eth.publicClient.getBalance({ address: keeper }),
      usdceBalance(eti.publicClient, config, keeper),
      eti.publicClient.readContract({ address: config.etica.etx, abi: abis.erc20Abi, functionName: 'balanceOf', args: [keeper] }),
    ]);
    log.info(
      `[bridge-seed] keeper ${keeper}: ${formatUnits(ethUsdc, STABLE_DECIMALS)} USDC + ${formatUnits(ethNative, 18)} ETH on Ethereum; ` +
        `${formatUnits(eticaUsdce, STABLE_DECIMALS)} USDC.e + ${formatUnits(eticaEtx, ETX_DECIMALS)} ETX on Etica; pair ${pair.address ?? 'not created'}`,
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
        error: `keeper holds ${formatUnits(eticaEtx, ETX_DECIMALS)} ETX, needs ${formatUnits(etxNeeded, ETX_DECIMALS)} (${formatUnits(config.etxAmount, ETX_DECIMALS)} pool + ${formatUnits(pairFee, ETX_DECIMALS)} pair fee)`,
      };
    }

    // ---- stage 1: bridge --------------------------------------------------
    let usdceForPool = config.usdcAmount === null ? eticaUsdce : eticaUsdce < config.usdcAmount ? eticaUsdce : config.usdcAmount;
    let bridged = 0n;
    const wantMore = config.usdcAmount === null ? eticaUsdce === 0n : eticaUsdce < config.usdcAmount;
    if (wantMore && ethUsdc >= MIN_BRIDGE_STABLE) {
      await verifyWarpRoute(eth.publicClient, config);
      const recipient = pad(keeper, { size: 32 });
      const available = config.usdcAmount === null ? ethUsdc : ethUsdc < config.usdcAmount ? ethUsdc : config.usdcAmount;
      // amount + fee(amount) must fit `available`; the fee quoted at `available` is an upper bound.
      const upper = await quoteBridge(eth.publicClient, config, recipient, available);
      let amount = affordableBridgeAmount(available, upper.tokenFee);
      if (config.usdcAmount !== null && available + upper.tokenFee <= ethUsdc) amount = available;
      if (amount < MIN_BRIDGE_STABLE) {
        return { dryRun, status: 'error', txHashes, error: `USDC ${formatUnits(ethUsdc, STABLE_DECIMALS)} does not cover the bridge fee ${formatUnits(upper.tokenFee, STABLE_DECIMALS)}` };
      }
      const { native, tokenFee } = await quoteBridge(eth.publicClient, config, recipient, amount);
      if (ethNative < native + ETH_GAS_RESERVE_WEI) {
        return { dryRun, status: 'error', txHashes, error: `keeper has ${formatUnits(ethNative, 18)} ETH, needs ${formatUnits(native, 18)} delivery payment + gas` };
      }
      log.info(`[bridge-seed] bridge ${formatUnits(amount, STABLE_DECIMALS)} USDC -> ${keeper} on Etica (fee ${formatUnits(tokenFee, STABLE_DECIMALS)} USDC, gas payment ${native} wei)`);
      if (!eth.walletClient) {
        // Dry run: assume the mint lands and keep going so the pool plan and price check are reported too.
        bridged = amount;
        usdceForPool = eticaUsdce + amount;
      } else {
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
        await send(hash, `transferRemote ${formatUnits(amount, STABLE_DECIMALS)} USDC -> Etica`);
        bridged = amount;
        // ---- stage 2: mint ----------------------------------------------
        const target = eticaUsdce + amount;
        const bal = await waitForMint(eti.publicClient, config, keeper, target, log, sleep);
        if (bal < target) {
          return { dryRun, status: 'waiting', txHashes, bridged: bridged.toString(), error: `USDC.e mint not seen within ${config.mintTimeoutMs / 1000}s (balance ${formatUnits(bal, STABLE_DECIMALS)}); re-dispatch to resume` };
        }
        usdceForPool = bal;
      }
      if (config.usdcAmount !== null && usdceForPool > config.usdcAmount) usdceForPool = config.usdcAmount;
    } else if (wantMore) {
      // Nothing left to bridge: either a previous run's transfer is in flight or the wallet was never funded.
      if (dryRun || ethUsdc > 0n || eticaUsdce > 0n) {
        return { dryRun, status: dryRun ? 'planned' : 'waiting', txHashes, error: `no USDC to bridge (${formatUnits(ethUsdc, STABLE_DECIMALS)}) and only ${formatUnits(eticaUsdce, STABLE_DECIMALS)} USDC.e on Etica` };
      }
      return { dryRun, status: 'error', txHashes, error: 'keeper holds no USDC on Ethereum and no USDC.e on Etica' };
    }
    if (usdceForPool < MIN_BRIDGE_STABLE) {
      return { dryRun, status: 'error', txHashes, error: `only ${formatUnits(usdceForPool, STABLE_DECIMALS)} USDC.e available for the pool` };
    }

    // ---- price sanity ----------------------------------------------------
    const pool = poolUsdPerEtx(usdceForPool, STABLE_DECIMALS, config.etxAmount);
    const result: BridgeSeedResult = {
      dryRun,
      status: 'planned',
      txHashes,
      bridged: bridged.toString(),
      usdce: usdceForPool.toString(),
      etx: config.etxAmount.toString(),
      pairFee: pairFee.toString(),
      poolUsdPerEtx: formatUnits(pool, 18),
    };
    if (config.egazUsd !== null) {
      const amounts = await eti.publicClient.readContract({
        address: config.etica.swapRouter,
        abi: abis.routerAbi,
        functionName: 'getAmountsOut',
        args: [10n ** 18n, [config.etica.etx, config.etica.wegaz]],
      });
      const market = marketUsdPerEtx(amounts[amounts.length - 1]!, config.egazUsd);
      const deviation = priceDeviationBps(pool, market);
      result.marketUsdPerEtx = formatUnits(market, 18);
      result.priceDeviationBps = deviation?.toString();
      if (deviation === null || deviation > BigInt(config.maxPriceDeviationBps)) {
        return { ...result, status: 'error', error: `pool price ${result.poolUsdPerEtx} USD/ETX is ${deviation ?? '∞'} bps off the ETX/WEGAZ-implied ${result.marketUsdPerEtx} (max ${config.maxPriceDeviationBps})` };
      }
    } else {
      log.warn('[bridge-seed] BRIDGE_SEED_EGAZ_USD unset: skipping the market-price check');
    }
    log.info(
      `[bridge-seed] pool: ${formatUnits(usdceForPool, STABLE_DECIMALS)} USDC.e + ${formatUnits(config.etxAmount, ETX_DECIMALS)} ETX ` +
        `(${result.poolUsdPerEtx} USD/ETX${result.marketUsdPerEtx ? `, market ${result.marketUsdPerEtx}, Δ ${result.priceDeviationBps} bps` : ''}), ` +
        `pair fee ${formatUnits(pairFee, ETX_DECIMALS)} ETX, LP -> ${DEAD_ADDRESS}`,
    );
    if (!eti.walletClient) return result;

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
    const [deadLp, totalLp] = await Promise.all([
      eti.publicClient.readContract({ address: after.address, abi: abis.erc20Abi, functionName: 'balanceOf', args: [DEAD_ADDRESS] }),
      eti.publicClient.readContract({ address: after.address, abi: abis.pairAbi, functionName: 'totalSupply' }),
    ]);
    if (deadLp === 0n) throw new Error(`pair ${after.address} minted no LP to the dead address`);
    if (deadLp + MINIMUM_LIQUIDITY < totalLp) {
      log.warn(`[bridge-seed] dead address holds ${deadLp} of ${totalLp} LP (someone else also provided liquidity)`);
    }
    log.info(`[bridge-seed] pool ${after.address} live: ${formatUnits(after.reserveUsdce, STABLE_DECIMALS)} USDC.e / ${formatUnits(after.reserveEtx, ETX_DECIMALS)} ETX; ${deadLp} LP burned`);
    return { ...result, status: 'seeded', pair: after.address, usdce: after.reserveUsdce.toString(), etx: after.reserveEtx.toString(), deadLp: deadLp.toString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[bridge-seed] ${msg}`);
    return { dryRun, status: 'error', txHashes, error: msg };
  }
}
