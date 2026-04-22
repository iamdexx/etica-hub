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

export interface UsdAnchors {
  /** 1 ETI = N USD (spot), or null if NonKYC is unreachable or untraded. */
  etiUsd: number | null;
  /** 1 EGAZ = N USD (spot). */
  egazUsd: number | null;
}

interface NonkycTicker {
  symbol?: string;
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
  config: BuyBotConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<UsdAnchors> {
  const url = `${config.nonkycApiUrl.replace(/\/$/, '')}/api/v2/ticker`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { etiUsd: null, egazUsd: null };
    const data = (await res.json()) as NonkycTicker[] | { tickers?: NonkycTicker[] };
    const tickers: NonkycTicker[] = Array.isArray(data) ? data : (data.tickers ?? []);

    const find = (symbol: string): number | null => {
      const match = tickers.find(
        (t) => typeof t.symbol === 'string' && t.symbol.toUpperCase() === symbol,
      );
      if (!match) return null;
      return parsePrice(match.last_price ?? match.lastPrice);
    };
    return {
      etiUsd: find('ETI/USDT'),
      egazUsd: find('EGAZ/USDT'),
    };
  } catch {
    return { etiUsd: null, egazUsd: null };
  }
}
