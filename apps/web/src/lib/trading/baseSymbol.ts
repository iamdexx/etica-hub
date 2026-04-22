import type { Address } from 'viem';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  isSupportedChainId,
  type SupportedChainId,
} from '@etica-hub/shared';

/**
 * Trade-tab base symbols: what you are buying/selling against ETX.
 *
 *   ETI/ETX   — ETI denominated in ETX
 *   EGAZ/ETX  — EGAZ (native) denominated in ETX; the router bridges to WEGAZ
 *   stETX/ETX — liquid-staking receipt denominated in ETX
 *
 * stETX is a live base once its vault is deployed on-chain. On pre-deploy
 * chains DEPLOYMENTS[chain].stakedETX is the zero address and the symbol is
 * filtered out of `availableTradeBaseSymbols`, so the token picker never
 * surfaces it against an address it cannot trade.
 */
export type TradeBaseSymbol = 'ETI' | 'EGAZ' | 'stETX';

export type PairId = 'ETI-ETX' | 'EGAZ-ETX' | 'stETX-ETX';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export const TRADE_BASE_PAIR_IDS: Record<TradeBaseSymbol, PairId> = {
  ETI: 'ETI-ETX',
  EGAZ: 'EGAZ-ETX',
  stETX: 'stETX-ETX',
};

/**
 * Parse a URL-slug token identifier (case-insensitive) into a concrete base
 * symbol. Returns null for unrecognized values so route handlers can 404.
 */
export function parseTradeBaseSymbol(raw: string): TradeBaseSymbol | null {
  const upper = raw.toUpperCase();
  if (upper === 'ETI') return 'ETI';
  if (upper === 'EGAZ') return 'EGAZ';
  if (upper === 'STETX') return 'stETX';
  return null;
}

/**
 * Resolve the ERC-20 address the base symbol represents against its ETX
 * quote. Returns the zero address when the chain is not supported or the
 * token is not yet deployed — callers must treat zero as "not tradable".
 */
export function resolveBaseTokenAddress(
  chainId: number,
  baseSymbol: TradeBaseSymbol,
): Address {
  if (!isSupportedChainId(chainId)) return ZERO;
  const supported: SupportedChainId = chainId;
  const d = DEPLOYMENTS[supported];
  const ext = EXTERNAL_ADDRESSES[supported];
  if (baseSymbol === 'ETI') return ext.eti;
  if (baseSymbol === 'EGAZ') return d.wegaz;
  return d.stakedETX;
}

/**
 * The set of base symbols that are currently tradable on `chainId` — i.e.
 * for which `resolveBaseTokenAddress` would return a non-zero address. Used
 * by the token-picker to hide stETX on chains where the vault is not yet
 * deployed.
 */
export function availableTradeBaseSymbols(chainId: number): TradeBaseSymbol[] {
  const all: TradeBaseSymbol[] = ['ETI', 'EGAZ', 'stETX'];
  return all.filter((s) => resolveBaseTokenAddress(chainId, s) !== ZERO);
}
