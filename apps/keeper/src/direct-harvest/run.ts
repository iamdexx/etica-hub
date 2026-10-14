import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abis } from '@etica-hub/shared';

import type { DirectHarvestConfig } from './config.js';
import {
  buildDirectHarvestPlan,
  type DirectHarvestPlan,
  type LegQuote,
  type WindowSnapshot,
} from './plan.js';

export const DIRECT_FACTORY_ABI = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
  'function isMetaPair(address) view returns (bool)',
  'function swapsOpen(address) view returns (bool)',
]);

export const DIRECT_PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

export const DIRECT_HARVESTER_ABI = parseAbi([
  'function keepers(address) view returns (bool)',
  'function treasuryToken() view returns (address)',
  'function treasuryBps() view returns (uint16)',
  'function harvest((address pair,uint256 minEtxOut0,uint256 minEtxOut1,uint256 minPolOut0,uint256 minPolOut1)[] plans, uint256 minTreasuryOut) returns (uint256 totalEtx, uint256 polLpBurned)',
]);

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Etica RPC nodes reject txs whose fee exceeds 1 EGAZ; stay at 90% of it. */
export const RPC_TX_FEE_CAP_WEI = 10n ** 18n;
export const MIN_GAS_PRICE_WEI = 10n ** 9n;
export function capGasPrice(gas: bigint, gasPrice: bigint): bigint {
  if (gas <= 0n) return gasPrice;
  const maxPrice = (RPC_TX_FEE_CAP_WEI * 9n) / 10n / gas;
  if (gasPrice <= maxPrice) return gasPrice;
  return maxPrice > MIN_GAS_PRICE_WEI ? maxPrice : MIN_GAS_PRICE_WEI;
}

export interface DirectHarvestRunResult {
  dryRun: boolean;
  plan: DirectHarvestPlan;
  txHash?: `0x${string}`;
  error?: string;
}

export interface DirectHarvestDeps {
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export async function readWindows(
  client: PublicClient,
  factory: Address,
): Promise<WindowSnapshot[]> {
  const n = (await client.readContract({
    address: factory,
    abi: DIRECT_FACTORY_ABI,
    functionName: 'allPairsLength',
  })) as bigint;
  const out: WindowSnapshot[] = [];
  for (let i = 0n; i < n; i++) {
    const pair = (await client.readContract({
      address: factory,
      abi: DIRECT_FACTORY_ABI,
      functionName: 'allPairs',
      args: [i],
    })) as Address;
    const [token0, token1] = (await Promise.all([
      client.readContract({ address: pair, abi: DIRECT_PAIR_ABI, functionName: 'token0' }),
      client.readContract({ address: pair, abi: DIRECT_PAIR_ABI, functionName: 'token1' }),
    ])) as [Address, Address];
    out.push({ pair, token0, token1 });
  }
  return out;
}

export async function runDirectHarvest(
  config: DirectHarvestConfig,
  deps: DirectHarvestDeps = {},
): Promise<DirectHarvestRunResult> {
  const log = deps.log ?? console;
  const client = deps.publicClient ?? createPublicClient({ transport: http(config.rpcUrl) });
  const harv = { address: config.harvester, abi: DIRECT_HARVESTER_ABI } as const;

  const windows = await readWindows(client, config.factory);
  const tokens = [
    ...new Set(
      windows
        .flatMap((w) => [w.token0, w.token1])
        .map((t) => t.toLowerCase() as Address)
        .filter((t) => t !== config.etx.toLowerCase()),
    ),
  ];
  const [treasuryToken, treasuryBps, looseEtx, ...balances] = (await Promise.all([
    client.readContract({ ...harv, functionName: 'treasuryToken' }),
    client.readContract({ ...harv, functionName: 'treasuryBps' }),
    client.readContract({
      address: config.etx,
      abi: abis.erc20Abi,
      functionName: 'balanceOf',
      args: [config.harvester],
    }),
    ...tokens.map((t) =>
      client.readContract({
        address: t,
        abi: abis.erc20Abi,
        functionName: 'balanceOf',
        args: [config.harvester],
      }),
    ),
  ])) as [Address, number, bigint, ...bigint[]];

  const quotes: LegQuote[] = await Promise.all(
    tokens.map(async (token, i) => {
      const amount = balances[i] ?? 0n;
      if (amount === 0n) return { token, amount, etxOut: 0n };
      try {
        const amounts = (await client.readContract({
          address: config.hubRouter,
          abi: abis.routerAbi,
          functionName: 'getAmountsOut',
          args: [amount, [token, config.etx]],
        })) as readonly bigint[];
        return { token, amount, etxOut: amounts[1] ?? 0n };
      } catch {
        return { token, amount, etxOut: 0n };
      }
    }),
  );

  let treasuryPool: { etx: bigint; treasuryToken: bigint } | null = null;
  const tTok = treasuryToken === ZERO ? null : treasuryToken;
  if (tTok && tTok.toLowerCase() !== config.etx.toLowerCase()) {
    const hubFactory = (await client.readContract({
      address: config.hubRouter,
      abi: abis.routerAbi,
      functionName: 'factory',
    })) as Address;
    const pool = (await client.readContract({
      address: hubFactory,
      abi: abis.factoryAbi,
      functionName: 'getPair',
      args: [config.etx, tTok],
    })) as Address;
    if (pool !== ZERO) {
      const [t0, reserves] = (await Promise.all([
        client.readContract({ address: pool, abi: abis.pairAbi, functionName: 'token0' }),
        client.readContract({ address: pool, abi: abis.pairAbi, functionName: 'getReserves' }),
      ])) as [Address, readonly [bigint, bigint, number]];
      const etxIs0 = t0.toLowerCase() === config.etx.toLowerCase();
      treasuryPool = {
        etx: etxIs0 ? reserves[0] : reserves[1],
        treasuryToken: etxIs0 ? reserves[1] : reserves[0],
      };
    }
  }

  const plan = buildDirectHarvestPlan({
    windows,
    quotes,
    etx: config.etx,
    looseEtx,
    treasuryBps: Number(treasuryBps),
    treasuryToken: tTok,
    treasuryPool,
    maxSlippageBps: config.maxSlippageBps,
    minEtxWei: config.minEtxWei,
  });

  for (const q of quotes) {
    log.info(`[direct-harvest] ${q.token}: ${q.amount} held, ${q.etxOut} ETX quoted`);
  }
  if (plan.skipReason) {
    log.info(`[direct-harvest] skip: ${plan.skipReason}`);
    return { dryRun: config.dryRun, plan };
  }
  log.info(
    `[direct-harvest] ${plan.plans.length} window(s), expected ${plan.expectedEtx} ETX, ` +
      `treasury min-out ${plan.minTreasuryOut}`,
  );
  if (config.dryRun) return { dryRun: true, plan };
  if (!config.privateKey) {
    return { dryRun: false, plan, error: 'HARVEST_PRIVATE_KEY unset' };
  }

  const account = privateKeyToAccount(config.privateKey);
  const isKeeper = (await client.readContract({
    ...harv,
    functionName: 'keepers',
    args: [account.address],
  })) as boolean;
  if (!isKeeper) {
    return {
      dryRun: false,
      plan,
      error: `${account.address} is not a harvester keeper; run harvester.setKeeper first`,
    };
  }

  const args = [plan.plans, plan.minTreasuryOut] as const;
  const [gas, gasPrice] = await Promise.all([
    client.estimateContractGas({ ...harv, functionName: 'harvest', args, account }),
    client.getGasPrice(),
  ]);
  const gasLimit = (gas * 13n) / 10n;
  const wallet =
    deps.walletClient ?? createWalletClient({ account, transport: http(config.rpcUrl) });
  try {
    const txHash = await wallet.writeContract({
      chain: null,
      account,
      ...harv,
      functionName: 'harvest',
      args,
      gas: gasLimit,
      gasPrice: capGasPrice(gasLimit, gasPrice),
      type: 'legacy',
    });
    log.info(`[direct-harvest] submitted ${txHash}`);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      return { dryRun: false, plan, txHash, error: 'harvest tx reverted' };
    }
    return { dryRun: false, plan, txHash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`[direct-harvest] failed: ${msg}`);
    return { dryRun: false, plan, error: msg };
  }
}
