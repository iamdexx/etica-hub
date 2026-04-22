/**
 * On-chain scanner for the buy bot.
 *
 * - Enumerates every pair registered on the EticaHub factory (hub-and-spoke
 *   means every pair contains ETX). We fetch this once per cron run; the
 *   factory emits `PairCreated` as new tokens list, so we naturally pick up
 *   new pools without any restart.
 * - Resolves each pair's `token0`/`token1` metadata once (symbol, decimals,
 *   totalSupply) and caches it for the duration of the run.
 * - Pulls the `Swap` event delta across every pair in a single
 *   `getLogs` RPC (server-side filtered by address list).
 * - For each swap, reads the pair's post-swap reserves at the exact block
 *   via a stateOverride-free `getReserves` call — good enough for the
 *   price/MC figures we surface to Telegram.
 */

import {
  decodeEventLog,
  erc20Abi,
  getAddress,
  type Address,
  type Log,
  type PublicClient,
} from 'viem';
import { abis } from '@etica-hub/shared';
import type { BuyBotConfig } from './config';
import type { PoolSnapshot, TokenMeta, SwapEventArgs } from './prices';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export const SWAP_EVENT = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { indexed: true, name: 'sender', type: 'address' },
    { indexed: false, name: 'amount0In', type: 'uint256' },
    { indexed: false, name: 'amount1In', type: 'uint256' },
    { indexed: false, name: 'amount0Out', type: 'uint256' },
    { indexed: false, name: 'amount1Out', type: 'uint256' },
    { indexed: true, name: 'to', type: 'address' },
  ],
} as const;

export interface SwapEvent {
  pair: Address;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  args: SwapEventArgs;
}

export interface ScanWindow {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Fetch metadata (symbol, decimals, totalSupply) for a single ERC-20 token.
 * Hardens against tokens that return `bytes32` symbols by falling back to
 * the token's address as a last-resort display symbol.
 */
async function fetchTokenMeta(client: PublicClient, address: Address): Promise<TokenMeta> {
  const [symbol, decimals, totalSupply] = await Promise.all([
    client
      .readContract({ abi: erc20Abi, address, functionName: 'symbol' })
      .catch(() => address.slice(0, 6)) as Promise<string>,
    client.readContract({
      abi: erc20Abi,
      address,
      functionName: 'decimals',
    }) as Promise<number>,
    client.readContract({
      abi: erc20Abi,
      address,
      functionName: 'totalSupply',
    }) as Promise<bigint>,
  ]);
  return { address: getAddress(address), symbol, decimals, totalSupply };
}

export async function loadAllPairs(client: PublicClient, factory: Address): Promise<Address[]> {
  if (factory === ZERO_ADDRESS) return [];
  const length = (await client.readContract({
    abi: abis.factoryAbi,
    address: factory,
    functionName: 'allPairsLength',
  })) as bigint;
  const n = Number(length);
  if (n === 0) return [];
  return Promise.all(
    Array.from(
      { length: n },
      (_, i) =>
        client.readContract({
          abi: abis.factoryAbi,
          address: factory,
          functionName: 'allPairs',
          args: [BigInt(i)],
        }) as Promise<Address>,
    ),
  );
}

/**
 * Scan the block range for `Swap` events across every provided pair.
 * Returns them in chain order (`blockNumber` ASC, `logIndex` ASC).
 */
export async function fetchSwapsInRange(
  client: PublicClient,
  pairs: Address[],
  window: ScanWindow,
): Promise<SwapEvent[]> {
  if (pairs.length === 0) return [];
  if (window.toBlock < window.fromBlock) return [];

  const logs = (await client.getLogs({
    address: pairs,
    event: SWAP_EVENT,
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
  })) as Log[];

  const decoded: SwapEvent[] = [];
  for (const log of logs) {
    if (log.blockNumber === null || log.logIndex === null) continue;
    try {
      const d = decodeEventLog({
        abi: [SWAP_EVENT],
        data: log.data,
        topics: log.topics,
      });
      if (d.eventName !== 'Swap') continue;
      const a = d.args as unknown as SwapEventArgs;
      decoded.push({
        pair: getAddress(log.address),
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        txHash: log.transactionHash as `0x${string}`,
        args: a,
      });
    } catch {
      // Malformed log — skip rather than poison the whole cron run.
    }
  }

  decoded.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber < b.blockNumber ? -1 : 1;
    }
    return a.logIndex - b.logIndex;
  });
  return decoded;
}

/**
 * Resolve a pair to a full {@link PoolSnapshot} at a given block. Looks up
 * token0 + token1 + current reserves + both tokens' totalSupply.
 *
 * Each pair goes through {@link fetchTokenMeta} once per call; callers that
 * process many swaps across the same pools should memoize at the call site.
 */
export async function snapshotPool(
  client: PublicClient,
  pair: Address,
  blockNumber: bigint,
): Promise<PoolSnapshot | null> {
  try {
    const [token0, token1, reserves] = await Promise.all([
      client.readContract({
        abi: abis.pairAbi,
        address: pair,
        functionName: 'token0',
        blockNumber,
      }) as Promise<Address>,
      client.readContract({
        abi: abis.pairAbi,
        address: pair,
        functionName: 'token1',
        blockNumber,
      }) as Promise<Address>,
      client.readContract({
        abi: abis.pairAbi,
        address: pair,
        functionName: 'getReserves',
        blockNumber,
      }) as Promise<readonly [bigint, bigint, number]>,
    ]);

    const [t0Meta, t1Meta] = await Promise.all([
      fetchTokenMeta(client, token0),
      fetchTokenMeta(client, token1),
    ]);

    return {
      pair: getAddress(pair),
      token0: t0Meta,
      token1: t1Meta,
      reserve0After: reserves[0],
      reserve1After: reserves[1],
    };
  } catch {
    return null;
  }
}

/**
 * Compute the block range to scan this cron run.
 *
 * - With a persisted `lastScannedBlock`: scan everything newer than it,
 *   capped at `maxBlocksPerRun` so a first-deploy catch-up doesn't DOS the
 *   RPC or blow past Vercel's function timeout.
 * - Without one: assume fresh deploy and scan only the last
 *   `freshDeployLookback` blocks so the channel doesn't immediately flood
 *   with a week of historical buys.
 */
export function planScanWindow(
  latestBlock: bigint,
  lastScanned: bigint | null,
  config: Pick<BuyBotConfig, 'maxBlocksPerRun'>,
  freshDeployLookback = 50n,
): ScanWindow {
  const cap = BigInt(config.maxBlocksPerRun);
  if (lastScanned === null || lastScanned >= latestBlock) {
    const from = latestBlock > freshDeployLookback ? latestBlock - freshDeployLookback : 0n;
    return { fromBlock: from, toBlock: latestBlock };
  }
  const from = lastScanned + 1n;
  const windowSize = latestBlock - from + 1n;
  const toBlock = windowSize > cap ? from + cap - 1n : latestBlock;
  return { fromBlock: from, toBlock };
}
