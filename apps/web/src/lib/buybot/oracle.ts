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
