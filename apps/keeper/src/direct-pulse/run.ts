import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abis } from '@etica-hub/shared';

import type { DirectPulseConfig } from './config.js';
import {
  buildPulsePlan,
  sizeTrip,
  withSlippage,
  type PulseLeg,
  type PulsePlan,
  type PulseWindow,
} from './plan.js';
import { capGasPrice, DIRECT_FACTORY_ABI, DIRECT_PAIR_ABI } from '../direct-harvest/run.js';

const GATE_ABI = parseAbi([
  'function isAllowed(address) view returns (bool)',
  'function whitelist(address) view returns (bool)',
]);
/** EticaDirectMetaPair: quotes and swaps settle on the hub at spot, so the V2
 * router's constant-product `getAmountsOut` over-quotes them (and reverts). */
const META_PAIR_ABI = parseAbi([
  'function liveReserves() view returns (uint256,uint256)',
  'function quoteOut(address tokenIn, uint256 amountIn, address trader) view returns (uint256)',
  'function swapExactIn(address tokenIn, uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline) returns (uint256)',
]);
const WRAPPED_EGAZ_ABI = parseAbi(['function deposit() payable', 'function withdraw(uint256 wad)']);
const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);

/** Public Etica nodes cap eth_getLogs ranges; stay well under. */
export const LOG_CHUNK = 2_000n;

export interface PulseLegResult {
  path: Address[];
  txHash?: Hex;
  amountIn: bigint;
  amountOut?: bigint;
  error?: string;
}

export interface DirectPulseRunResult {
  dryRun: boolean;
  plan: PulsePlan;
  windows: PulseWindow[];
  legs: PulseLegResult[];
  error?: string;
}

export interface DirectPulseDeps {
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

async function newestSwap(
  client: PublicClient,
  pairs: Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Map<string, bigint>> {
  const newest = new Map<string, bigint>();
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n < toBlock ? start + LOG_CHUNK - 1n : toBlock;
    const logs = await client.getLogs({ address: pairs, event: SWAP_EVENT, fromBlock: start, toBlock: end });
    for (const l of logs) {
      const k = l.address.toLowerCase();
      const prev = newest.get(k);
      if (prev === undefined || l.blockNumber > prev) newest.set(k, l.blockNumber);
    }
  }
  return newest;
}

export async function loadWindows(
  client: PublicClient,
  cfg: DirectPulseConfig,
  now: number,
): Promise<PulseWindow[]> {
  const fac = { address: cfg.factory, abi: DIRECT_FACTORY_ABI } as const;
  const n = (await client.readContract({ ...fac, functionName: 'allPairsLength' })) as bigint;
  const pairs: Address[] = [];
  for (let i = 0n; i < n; i++) {
    pairs.push((await client.readContract({ ...fac, functionName: 'allPairs', args: [i] })) as Address);
  }
  const head = await client.getBlock();
  const probe = head.number > 1000n ? head.number - 1000n : 0n;
  const old = await client.getBlock({ blockNumber: probe });
  const secPerBlock =
    head.number > probe ? Number(head.timestamp - old.timestamp) / Number(head.number - probe) : 13;
  const span = BigInt(Math.ceil((cfg.maxQuietSeconds * 1.25) / Math.max(secPerBlock, 1)));
  const fromBlock = head.number > span ? head.number - span : 0n;
  const swaps = await newestSwap(client, pairs, fromBlock, head.number);
  const blockTs = new Map<bigint, number>();
  const out: PulseWindow[] = [];
  for (const pair of pairs) {
    const [token0, token1, open, reserves] = await Promise.all([
      client.readContract({ address: pair, abi: DIRECT_PAIR_ABI, functionName: 'token0' }) as Promise<Address>,
      client.readContract({ address: pair, abi: DIRECT_PAIR_ABI, functionName: 'token1' }) as Promise<Address>,
      client.readContract({ ...fac, functionName: 'swapsOpen', args: [pair] }) as Promise<boolean>,
      (client.readContract({ address: pair, abi: META_PAIR_ABI, functionName: 'liveReserves' }) as Promise<
        readonly [bigint, bigint]
      >).catch(() => undefined),
    ]);
    const bn = swaps.get(pair.toLowerCase());
    let lastSwapAt: number | null = null;
    if (bn !== undefined) {
      let ts = blockTs.get(bn);
      if (ts === undefined) {
        ts = Number((await client.getBlock({ blockNumber: bn })).timestamp);
        blockTs.set(bn, ts);
      }
      lastSwapAt = ts;
    }
    out.push({ pair, token0, token1, lastSwapAt, paused: !open, reserves });
  }
  void now;
  return out;
}

export async function runDirectPulse(
  config: DirectPulseConfig,
  deps: DirectPulseDeps = {},
): Promise<DirectPulseRunResult> {
  const log = deps.log ?? console;
  const client = deps.publicClient ?? createPublicClient({ transport: http(config.rpcUrl) });
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const windows = await loadWindows(client, config, now);
  const plan = buildPulsePlan({ windows, wegaz: config.wegaz, now, maxQuietSeconds: config.maxQuietSeconds });
  const legs: PulseLegResult[] = [];
  if (plan.trips.length === 0) {
    log.info('[direct-pulse] every window traded recently; nothing to do');
    return { dryRun: config.dryRun, plan, windows, legs };
  }
  if (config.dryRun) return { dryRun: true, plan, windows, legs };
  if (!config.privateKey) return { dryRun: false, plan, windows, legs, error: 'HARVEST_PRIVATE_KEY unset' };

  const account = privateKeyToAccount(config.privateKey);
  const gate = { address: config.factory, abi: GATE_ABI } as const;
  const allowed = (await client.readContract({ ...gate, functionName: 'isAllowed', args: [account.address] })) as boolean;
  if (!allowed) {
    return {
      dryRun: false,
      plan,
      windows,
      legs,
      error: `${account.address} fails the stETX gate; factory.setWhitelist(keeper, true) via the 2-of-2 first`,
    };
  }
  const egaz = await client.getBalance({ address: account.address });
  if (egaz < config.amountWei * 2n) {
    return { dryRun: false, plan, windows, legs, error: `keeper holds ${egaz} wei EGAZ, needs ${config.amountWei * 2n}` };
  }
  const wallet = deps.walletClient ?? createWalletClient({ account, transport: http(config.rpcUrl) });

  const send = async (to: Address, data: Hex, value: bigint): Promise<Hex> => {
    const [gas, gasPrice] = await Promise.all([client.estimateGas({ account, to, data, value }), client.getGasPrice()]);
    const gasLimit = (gas * 13n) / 10n;
    const txHash = await wallet.sendTransaction({
      chain: null,
      account,
      to,
      data,
      value,
      gas: gasLimit,
      gasPrice: capGasPrice(gasLimit, gasPrice),
      type: 'legacy',
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`tx ${txHash} reverted`);
    return txHash;
  };
  const balanceOf = (token: Address) =>
    client.readContract({ address: token, abi: abis.erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>;
  const ensureAllowance = async (token: Address, spender: Address, amount: bigint) => {
    const allowance = (await client.readContract({
      address: token,
      abi: abis.erc20Abi,
      functionName: 'allowance',
      args: [account.address, spender],
    })) as bigint;
    if (allowance >= amount) return;
    await send(
      token,
      encodeFunctionData({ abi: abis.erc20Abi, functionName: 'approve', args: [spender, 2n ** 256n - 1n] }),
      0n,
    );
  };

  /** One hop per window: `quoteOut` for the floor, `swapExactIn` on the pair itself. */
  const sendLeg = async (leg: PulseLeg, amountIn: bigint): Promise<PulseLegResult> => {
    const res: PulseLegResult = { path: leg.path, amountIn };
    try {
      let amount = amountIn;
      for (let i = 0; i < leg.pairs.length; i++) {
        const pair = leg.pairs[i] as Address;
        const tokenIn = leg.path[i] as Address;
        const tokenOut = leg.path[i + 1] as Address;
        const quotedOut = (await client.readContract({
          address: pair,
          abi: META_PAIR_ABI,
          functionName: 'quoteOut',
          args: [tokenIn, amount, account.address],
        })) as bigint;
        if (quotedOut === 0n) throw new Error(`${pair} quotes 0 out for ${amount} of ${tokenIn}`);
        const minOut = withSlippage(quotedOut, config.maxSlippageBps);
        await ensureAllowance(tokenIn, pair, amount);
        const before = await balanceOf(tokenOut);
        const txHash = await send(
          pair,
          encodeFunctionData({
            abi: META_PAIR_ABI,
            functionName: 'swapExactIn',
            args: [tokenIn, amount, minOut, account.address, BigInt(now + 1800)],
          }),
          0n,
        );
        res.txHash = txHash;
        const after = await balanceOf(tokenOut);
        amount = after > before ? after - before : quotedOut;
        log.info(`[direct-pulse] ${tokenIn} -> ${tokenOut} via ${pair} ${txHash}`);
      }
      res.amountOut = amount;
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
      log.error(`[direct-pulse] leg failed: ${res.error}`);
    }
    return res;
  };

  for (const trip of plan.trips) {
    const size = sizeTrip({
      trip,
      windows,
      wegaz: config.wegaz,
      amountWei: config.amountWei,
      maxReserveBps: config.maxReserveBps,
    });
    if (size === 0n) {
      legs.push({ path: trip.out.path, amountIn: 0n, error: `${trip.target} has no EGAZ-side reserve` });
      continue;
    }
    try {
      // Windows hold EGAZ in ERC-20 form; wrap exactly the trip size, unwrap whatever comes home.
      await send(config.wegaz, encodeFunctionData({ abi: WRAPPED_EGAZ_ABI, functionName: 'deposit' }), size);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      legs.push({ path: trip.out.path, amountIn: size, error: `wrap failed: ${msg}` });
      log.error(`[direct-pulse] wrap failed: ${msg}`);
      continue;
    }
    const out = await sendLeg(trip.out, size);
    legs.push(out);
    if (!out.error && out.amountOut !== undefined) {
      // Return exactly what the far leg delivered, read from the wallet so
      // rounding on the hub never leaves dust behind.
      const bal = await balanceOf(trip.back.path[0] as Address);
      legs.push(await sendLeg(trip.back, bal < out.amountOut ? bal : out.amountOut));
    }
    const wrapped = await balanceOf(config.wegaz);
    if (wrapped > 0n) {
      await send(
        config.wegaz,
        encodeFunctionData({ abi: WRAPPED_EGAZ_ABI, functionName: 'withdraw', args: [wrapped] }),
        0n,
      ).catch((e: unknown) => log.warn(`[direct-pulse] unwrap failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  const failed = legs.filter((l) => l.error).length;
  return failed ? { dryRun: false, plan, windows, legs, error: `${failed} leg(s) failed` } : { dryRun: false, plan, windows, legs };
}
