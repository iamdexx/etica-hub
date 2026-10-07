import { isAddressEqual, pad, parseUnits, zeroAddress, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { USDC_WARP_ROUTE } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';

export const ETHEREUM_DOMAIN = 1;
export const ETICA_DOMAIN = 61803;

export type UsdcDirection = 'toEtica' | 'toEthereum';
export type UsdcSourceChainId = typeof mainnet.id | typeof eticaMainnet.id;

export interface UsdcLeg {
  direction: UsdcDirection;
  sourceChainId: UsdcSourceChainId;
  destinationDomain: number;
  /** Warp router the user calls `transferRemote` on. */
  router: Address;
  /** ERC-20 the router charges (USDC on Ethereum; the USDC.e token is its own router on Etica). */
  token: Address;
  tokenSymbol: string;
  nativeSymbol: string;
  sourceName: string;
  destinationName: string;
  /** Collateral routers pull via `transferFrom`; the synthetic router burns the caller's balance directly. */
  needsApproval: boolean;
  feeNote: string;
  explorerTx: (hash: Hex) => string;
}

export const USDC_LEGS: Record<UsdcDirection, UsdcLeg> = {
  toEtica: {
    direction: 'toEtica',
    sourceChainId: mainnet.id,
    destinationDomain: ETICA_DOMAIN,
    router: USDC_WARP_ROUTE.collateralRouter,
    token: USDC_WARP_ROUTE.collateralToken,
    tokenSymbol: 'USDC',
    nativeSymbol: 'ETH',
    sourceName: 'Ethereum',
    destinationName: 'Etica',
    needsApproval: true,
    feeNote: '0.5% fee, capped at 50 USDC',
    explorerTx: (hash) => `https://etherscan.io/tx/${hash}`,
  },
  toEthereum: {
    direction: 'toEthereum',
    sourceChainId: eticaMainnet.id,
    destinationDomain: ETHEREUM_DOMAIN,
    router: USDC_WARP_ROUTE.syntheticToken,
    token: USDC_WARP_ROUTE.syntheticToken,
    tokenSymbol: USDC_WARP_ROUTE.symbol,
    nativeSymbol: 'EGAZ',
    sourceName: 'Etica',
    destinationName: 'Ethereum',
    needsApproval: false,
    feeNote: '2 USDC.e flat + 0.5%, capped at 50 USDC.e; releases are limited to 5,000 USDC per 24h',
    explorerTx: (hash) => `https://eticascan.org/tx/${hash}`,
  },
};

export interface WarpQuote {
  token: Address;
  amount: bigint;
}

/**
 * `quoteTransferRemote` returns one line per asset the router will take:
 * the native gas payment for delivery and the stable leg as amount + fee.
 */
export function splitWarpQuote(
  quotes: readonly WarpQuote[],
  stable: Address,
  amount: bigint,
): { native: bigint; tokenFee: bigint } {
  let native = 0n;
  let stableTotal = 0n;
  for (const q of quotes) {
    if (isAddressEqual(q.token, zeroAddress)) native += q.amount;
    else if (isAddressEqual(q.token, stable)) stableTotal += q.amount;
    else if (q.amount > 0n) throw new Error(`router quotes a fee in unexpected token ${q.token}`);
  }
  if (stableTotal < amount) throw new Error(`router quotes ${stableTotal} for a ${amount} transfer`);
  return { native, tokenFee: stableTotal - amount };
}

export function toBytes32Recipient(address: Address): Hex {
  return pad(address, { size: 32 });
}

/** Parses a user-typed USDC amount (6 decimals). Returns null for anything that is not a positive amount. */
export function parseUsdcAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const value = parseUnits(trimmed, USDC_WARP_ROUTE.decimals);
  return value > 0n ? value : null;
}
