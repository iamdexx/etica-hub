/**
 * Display helpers for the trade price headline + chart label.
 *
 * Background: the previous label `BASE / QUOTE  64.7246` was technically a
 * standard finance pair quote ("price of BASE in QUOTE"), but it was being
 * misread by community members as a literal division (`BASE ÷ QUOTE`),
 * giving the impression the API had flipped the orientation. To eliminate
 * the ambiguity, we now render an explicit `1 BASE = X QUOTE` headline.
 *
 * The `inverted` flag swaps to `1 QUOTE = X BASE` for users who prefer the
 * reciprocal mental model.
 */

/**
 * Format a price for display with adaptive precision. Mirrors the rule set
 * used inline in `PriceChart` and `OnChainPriceChart` so both charts share
 * exactly one source of truth.
 */
export function formatPriceRatio(latest: number): string {
  if (!Number.isFinite(latest) || latest <= 0) return '—';
  if (latest >= 100) return latest.toFixed(2);
  if (latest >= 1) return latest.toFixed(4);
  return latest.toFixed(6);
}

export interface PriceHeadlineArgs {
  base: string;
  quote: string;
  latest: number;
  inverted: boolean;
}

/**
 * Build the explicit `1 X = Y Z` headline used on the trade page.
 * - `inverted=false` ⇒ `1 BASE = N QUOTE` (default — matches the on-chain
 *   reserve ratio: `quoteReserve / baseReserve`).
 * - `inverted=true`  ⇒ `1 QUOTE = N BASE` (reciprocal — for users who want
 *   to see how many BASE one QUOTE buys).
 */
export function priceHeadline({ base, quote, latest, inverted }: PriceHeadlineArgs): string {
  if (!Number.isFinite(latest) || latest <= 0) return '—';
  return inverted
    ? `1 ${quote} = ${formatPriceRatio(latest)} ${base}`
    : `1 ${base} = ${formatPriceRatio(latest)} ${quote}`;
}

/**
 * Reciprocal helper. Returns 0 for non-finite or non-positive inputs so
 * downstream chart math stays in the "skip non-positive" rails it already
 * uses for raw reserves.
 */
export function invertPrice(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0;
  return 1 / p;
}

export type TimeWindow = '24h' | '7d' | '30d' | 'all';

export const TIME_WINDOWS: readonly TimeWindow[] = ['24h', '7d', '30d', 'all'] as const;

export const TIME_WINDOW_SECONDS: Record<TimeWindow, number | null> = {
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
  all: null,
};

export const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};

/**
 * Filter a timestamped sample list to the visible window. `tsField` extracts
 * the unix timestamp (seconds) from each sample. `nowSec` is injectable so
 * tests can pin "now" deterministically.
 */
export function filterSamplesToWindow<T>(
  samples: readonly T[],
  windowKey: TimeWindow,
  tsField: (s: T) => number,
  nowSec: number = Math.floor(Date.now() / 1000),
): T[] {
  const win = TIME_WINDOW_SECONDS[windowKey];
  if (win === null) return [...samples];
  const cutoff = nowSec - win;
  return samples.filter((s) => tsField(s) >= cutoff);
}
