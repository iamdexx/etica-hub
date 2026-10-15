import { getAddress, type Address, type PublicClient } from 'viem';
import { abis } from '@etica-hub/shared';
import { isDirectWindow } from './priceApi';
import { resolveTokenInfos, type TokenInfo } from './token';

export interface PairInfo {
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  tokens: Map<string, TokenInfo>;
  /** Direct (V5) window: liquidity is ETX hub LP, reserves are the hub-backed view. */
  direct: boolean;
}

/**
 * Probes `addr` for the UniswapV2 pair surface (token0/token1/getReserves).
 * Returns null for anything that is not a pair (EOAs, plain tokens, other
 * contracts) so callers can fall back to the generic contract view.
 */
export async function readPairInfo(client: PublicClient, addr: Address): Promise<PairInfo | null> {
  try {
    const [token0, token1, reserves, totalSupply] = await Promise.all([
      client.readContract({ abi: abis.pairAbi, address: addr, functionName: 'token0' }) as Promise<Address>,
      client.readContract({ abi: abis.pairAbi, address: addr, functionName: 'token1' }) as Promise<Address>,
      client.readContract({ abi: abis.pairAbi, address: addr, functionName: 'getReserves' }) as Promise<
        readonly [bigint, bigint, number]
      >,
      client.readContract({ abi: abis.pairAbi, address: addr, functionName: 'totalSupply' }) as Promise<bigint>,
    ]);
    const [tokens, direct] = await Promise.all([
      resolveTokenInfos(client, [token0, token1]),
      isDirectWindow(addr, client),
    ]);
    return {
      token0: getAddress(token0),
      token1: getAddress(token1),
      reserve0: reserves[0],
      reserve1: reserves[1],
      totalSupply,
      tokens,
      direct,
    };
  } catch {
    return null;
  }
}
