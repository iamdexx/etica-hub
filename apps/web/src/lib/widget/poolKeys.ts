import type { Address } from 'viem';

export interface WidgetToken {
  /** ERC-20 address as the pool holds it (WEGAZ for native EGAZ). */
  address: Address;
  /** User-facing symbol: EGAZ, never WEGAZ. */
  symbol: string;
  decimals: number;
  /** Native EGAZ: balances come from the chain coin and the router's *EGAZ functions are used. */
  native: boolean;
}

/** One pool on the standalone V2 factory, serialisable (no bigints) so the server can hand it to the client. */
export interface WidgetPool {
  address: Address;
  /** URL key, e.g. `egaz-usdc.e`, `eti-etx`; legacy `egaz` / `eti` still resolve. */
  key: string;
  /** `EGAZ/USDC.e`: base first, quote second. */
  label: string;
  /** Base token (shown first; "1 base = x quote"). */
  base: WidgetToken;
  /** Quote token: USDC.e when present, else ETX, else the second token. */
  quote: WidgetToken;
}

const QUOTE_RANK: Record<string, number> = { 'usdc.e': 0, etx: 1, stetx: 2 };
function rank(sym: string): number {
  return QUOTE_RANK[sym.toLowerCase()] ?? 9;
}

/** Orders a pool's two tokens into base/quote and derives key + label. */
export function makeWidgetPool(address: Address, a: WidgetToken, b: WidgetToken): WidgetPool {
  // the better-ranked token (USDC.e, then ETX, then stETX) is the quote; on a tie keep on-chain order
  const quote = rank(a.symbol) < rank(b.symbol) ? a : b;
  const base = quote === a ? b : a;
  return {
    address,
    key: `${base.symbol}-${quote.symbol}`.toLowerCase(),
    label: `${base.symbol}/${quote.symbol}`,
    base,
    quote,
  };
}

const LEGACY: Record<string, string> = { egaz: 'egaz-usdc.e', eti: 'eti-usdc.e' };

/** `?pair=` → pool: legacy keys, `base-quote` keys in either order, or the pool address. */
export function resolveWidgetPool(pools: WidgetPool[], param: string | undefined): WidgetPool | null {
  if (pools.length === 0) return null;
  const p = (param ?? '').trim().toLowerCase();
  if (!p) return pools[0] ?? null;
  const key = LEGACY[p] ?? p;
  const flipped = key.includes('-') ? key.split('-').reverse().join('-') : key;
  return (
    pools.find((x) => x.key === key || x.key === flipped) ??
    pools.find((x) => x.address.toLowerCase() === p) ??
    null
  );
}
