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
import { buildPulsePlan, withSlippage, type PulseLeg, type PulsePlan, type PulseWindow } from './plan.js';
import { capGasPrice, DIRECT_FACTORY_ABI, DIRECT_PAIR_ABI } from '../direct-harvest/run.js';

const GATE_ABI = parseAbi([
  'function isAllowed(address) view returns (bool)',
  'function whitelist(address) view returns (bool)',
]);
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
    const [token0, token1, open] = await Promise.all([
      client.readContract({ address: pair, abi: DIRECT_PAIR_ABI, functionName: 'token0' }) as Promise<Address>,
      client.readContract({ address: pair, abi: DIRECT_PAIR_ABI, functionName: 'token1' }) as Promise<Address>,
      client.readContract({ ...fac, functionName: 'swapsOpen', args: [pair] }) as Promise<boolean>,
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
    out.push({ pair, token0, token1, lastSwapAt, paused: !open });
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
  const router = { address: config.router, abi: abis.routerAbi } as const;

  const sendLeg = async (leg: PulseLeg, amountIn: bigint): Promise<PulseLegResult> => {
    const res: PulseLegResult = { path: leg.path, amountIn };
    try {
      const quoted = (await client.readContract({
        ...router,
        functionName: 'getAmountsOut',
        args: [amountIn, leg.path],
      })) as readonly bigint[];
      const quotedOut = quoted[quoted.length - 1] as bigint;
      const minOut = withSlippage(quotedOut, config.maxSlippageBps);
      const deadline = BigInt(now + 1800);
      const tokenIn = leg.path[0] as Address;
      const tokenOut = leg.path[leg.path.length - 1] as Address;
      const fromEgaz = same(tokenIn, config.wegaz);
      const toEgaz = same(tokenOut, config.wegaz);
      if (!fromEgaz) {
        const allowance = (await client.readContract({
          address: tokenIn,
          abi: abis.erc20Abi,
          functionName: 'allowance',
          args: [account.address, config.router],
        })) as bigint;
        if (allowance < amountIn) {
          const h = await wallet.writeContract({
            chain: null,
            account,
            address: tokenIn,
            abi: abis.erc20Abi,
            functionName: 'approve',
            args: [config.router, 2n ** 256n - 1n],
            type: 'legacy',
          });
          const rc = await client.waitForTransactionReceipt({ hash: h });
          if (rc.status !== 'success') throw new Error('approve reverted');
        }
      }
      const data = fromEgaz
        ? encodeFunctionData({
            abi: abis.routerAbi,
            functionName: 'swapExactEGAZForTokens',
            args: [minOut, leg.path, account.address, deadline],
          })
        : toEgaz
          ? encodeFunctionData({
              abi: abis.routerAbi,
              functionName: 'swapExactTokensForEGAZ',
              args: [amountIn, minOut, leg.path, account.address, deadline],
            })
          : encodeFunctionData({
              abi: abis.routerAbi,
              functionName: 'swapExactTokensForTokens',
              args: [amountIn, minOut, leg.path, account.address, deadline],
            });
      const value = fromEgaz ? amountIn : 0n;
      const [gas, gasPrice] = await Promise.all([
        client.estimateGas({ account, to: config.router, data, value }),
        client.getGasPrice(),
      ]);
      const gasLimit = (gas * 13n) / 10n;
      const txHash = await wallet.sendTransaction({
        chain: null,
        account,
        to: config.router,
        data,
        value,
        gas: gasLimit,
        gasPrice: capGasPrice(gasLimit, gasPrice),
        type: 'legacy',
      });
      res.txHash = txHash;
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('swap reverted');
      res.amountOut = quotedOut;
      log.info(`[direct-pulse] ${leg.path.length - 1} hop(s) ${txHash}`);
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
      log.error(`[direct-pulse] leg failed: ${res.error}`);
    }
    return res;
  };

  for (const trip of plan.trips) {
    const out = await sendLeg(trip.out, config.amountWei);
    legs.push(out);
    if (out.error || out.amountOut === undefined) continue;
    // Return exactly what the far token leg delivered, read from the wallet so
    // rounding on the hub never leaves dust behind.
    const far = trip.back.path[0] as Address;
    const bal = (await client.readContract({
      address: far,
      abi: abis.erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })) as bigint;
    const back = await sendLeg(trip.back, bal < out.amountOut ? bal : out.amountOut);
    legs.push(back);
  }
  const failed = legs.filter((l) => l.error).length;
  return failed ? { dryRun: false, plan, windows, legs, error: `${failed} leg(s) failed` } : { dryRun: false, plan, windows, legs };
}
