/**
 * USD price oracle for the buy bot.
 *
 * EticaHub pairs are all on-chain ETX-hub pairs (ETX paired against ETI,
 * EGAZ, or future launchpad tokens), so token-to-token prices come from pool
 * reserves. For USD figures we need a bridge to an external quote; we use
 * NonKYC's public REST API, which lists ETI/USDT and EGAZ/USDT. Every other
 * token's USD price is derived via the on-chain ETX pair price times one of
 * those external quotes.
 *
 * Why NonKYC: the only venue today that lists any Etica asset against USDT.
 * If more venues come online later, {@link fetchUsdAnchors} is the single
 * place to add a median / weighted-average.
 */

import { erc20Abi, getAddress, type Address, type PublicClient } from 'viem';

import type { BuyBotConfig } from './config';

/**
 * Structural subset of {@link BuyBotConfig} that {@link fetchUsdAnchors}
 * actually reads. Kept as a named type so non-buybot callers (e.g. the TVL
 * endpoint) don't have to fabricate a full buybot config just to resolve
 * ETI/EGAZ USDT quotes.
 */
export type UsdAnchorsConfig = Pick<BuyBotConfig, 'nonkycApiUrl'>;

/**
 * Subset of {@link BuyBotConfig} consumed by {@link fetchEgazNativeSupply}.
 */
export type EgazNativeSupplyConfig = Pick<BuyBotConfig, 'eticaStatsExplorerUrl'>;

export interface UsdAnchors {
  /** 1 ETI = N USD (spot), or null if NonKYC is unreachable or untraded. */
  etiUsd: number | null;
  /** 1 EGAZ = N USD (spot). */
  egazUsd: number | null;
}

interface NonkycTicker {
  /** CoinGecko-spec ticker ID, e.g. "ETI_USDT" / "EGAZ_USDT". */
  ticker_id?: string;
  /** Legacy/alternate symbol field, e.g. "ETI/USDT". */
  symbol?: string;
  base_currency?: string;
  target_currency?: string;
  last_price?: string;
  lastPrice?: string;
}

function parsePrice(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Hit NonKYC's `/api/v2/ticker` once and extract ETI/USDT and EGAZ/USDT last
 * trade price. A single round-trip covers both — cheaper than per-pair.
 *
 * Kept pure (passed a fetchImpl) so tests can stub it.
 */
export async function fetchUsdAnchors(
  config: UsdAnchorsConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<UsdAnchors> {
  const url = `${config.nonkycApiUrl.replace(/\/$/, '')}/api/v2/tickers`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { etiUsd: null, egazUsd: null };
    const data = (await res.json()) as NonkycTicker[] | { tickers?: NonkycTicker[] };
    const tickers: NonkycTicker[] = Array.isArray(data) ? data : (data.tickers ?? []);

    // NonKYC's CoinGecko-spec endpoint uses `ticker_id` like "ETI_USDT" and
    // splits `base_currency` / `target_currency`. Older variants returned
    // `symbol: "ETI/USDT"` — match either shape.
    const find = (base: string, quote: string): number | null => {
      const tickerId = `${base}_${quote}`;
      const slashSym = `${base}/${quote}`;
      const match = tickers.find((t) => {
        const idMatch = typeof t.ticker_id === 'string' && t.ticker_id.toUpperCase() === tickerId;
        const symMatch = typeof t.symbol === 'string' && t.symbol.toUpperCase() === slashSym;
        const pairMatch =
          typeof t.base_currency === 'string' &&
          typeof t.target_currency === 'string' &&
          t.base_currency.toUpperCase() === base &&
          t.target_currency.toUpperCase() === quote;
        return idMatch || symMatch || pairMatch;
      });
      if (!match) return null;
      return parsePrice(match.last_price ?? match.lastPrice);
    };
    return {
      etiUsd: find('ETI', 'USDT'),
      egazUsd: find('EGAZ', 'USDT'),
    };
  } catch {
    return { etiUsd: null, egazUsd: null };
  }
}

/**
 * Fetch the chain's native EGAZ total supply from the public BlockScout
 * explorer (`/api?module=stats&action=coinsupply`). Returned as a raw
 * 18-decimal `bigint` so callers can plug it directly into market-cap
 * calculations that already operate in raw units.
 *
 * EGAZ is the native gas token of the Etica chain; the
 * `WEGAZ.totalSupply()` ERC-20 read only counts the slice of EGAZ that's
 * been wrapped through the WEGAZ contract (today: ~1.93M of a ~20.16M
 * native supply). Reporting MC against the wrapped supply is misleading,
 * so the buy bot anchors WEGAZ MC to the native supply instead.
 *
 * Returns `null` on any network / parse error so callers can fall back to
 * the on-chain WEGAZ supply (or hide MC entirely) without crashing.
 */
/**
 * A registry entry telling the buy bot which addresses are non-circulating
 * holders of a given token (treasury wallet, fee splitters, timelocks,
 * bridge vaults). The bot reads each address's balance once per run and
 * subtracts the sum from `totalSupply()` before computing market cap.
 *
 * Aggregator-style "circulating supply" is the convention almost every
 * external pricing source publishes (CoinGecko, CMC, DEX Screener), so
 * matching it here keeps the buy-bot post in line with what users would
 * see anywhere else.
 *
 * Pool reserves are intentionally NOT excluded — once tokens sit in a
 * public LP they're swappable by anyone, which the standard convention
 * still considers circulating. The 10y-locked treasury LP shares are
 * captured indirectly by excluding the treasury wallet itself, which is
 * where any LP withdrawal would land in 2036.
 */
export interface CirculatingExclusionEntry {
  /** Token whose balance gets subtracted at each `holders` address. */
  token: Address;
  /** Non-circulating addresses (treasury, harvester, timelock, etc). */
  holders: Address[];
}

/**
 * Fetch the per-token sum of balances at non-circulating addresses, ready
 * for {@link SupplyOverrides.excludedSupplyByToken}.
 *
 * Multi-call semantics: every (token, holder) pair becomes a single
 * `balanceOf` read, and a failure on any one read collapses to `0n` for
 * that pair so a flaky RPC can't zero out an entire token's exclusion.
 *
 * Returns a `Map<Address, bigint>` keyed by `getAddress(token)` so the
 * pure pricing module can look up by checksummed address without
 * re-normalising.
 */
export async function fetchCirculatingExcludes(
  client: PublicClient,
  registry: CirculatingExclusionEntry[],
): Promise<Map<Address, bigint>> {
  const out = new Map<Address, bigint>();
  if (registry.length === 0) return out;

  // Flatten to (token, holder) pairs and read balances in parallel; one
  // round of Promise.all keeps cron latency flat regardless of how many
  // entries the registry grows to.
  const reads = registry.flatMap((entry) =>
    entry.holders.map(async (holder) => {
      try {
        const bal = (await client.readContract({
          abi: erc20Abi,
          address: entry.token,
          functionName: 'balanceOf',
          args: [holder],
        })) as bigint;
        return { token: entry.token, balance: bal };
      } catch {
        return { token: entry.token, balance: 0n };
      }
    }),
  );

  const results = await Promise.all(reads);
  for (const r of results) {
    const key = getAddress(r.token);
    out.set(key, (out.get(key) ?? 0n) + r.balance);
  }
  return out;
}

export async function fetchEgazNativeSupply(
  config: EgazNativeSupplyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint | null> {
  const base = config.eticaStatsExplorerUrl.replace(/\/$/, '');
  const url = `${base}/api?module=stats&action=coinsupply`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'text/plain, application/json' },
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res.ok) return null;
    // BlockScout's `coinsupply` returns a plain decimal number (e.g.
    // "20155344.625"), not JSON. We parse it as a fixed-point decimal so
    // the fractional part survives the conversion to 18-decimal raw units.
    const raw = (await res.text()).trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    const [intPart, fracPart = ''] = raw.split('.');
    const fracPadded = (fracPart + '0'.repeat(18)).slice(0, 18);
    const supply = BigInt(intPart) * 10n ** 18n + BigInt(fracPadded || '0');
    return supply > 0n ? supply : null;
  } catch {
    return null;
  }
}
