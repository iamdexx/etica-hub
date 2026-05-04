import { clsx, type ClassValue } from 'clsx';
import { formatUnits } from 'viem';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function shortAddress(address: string): string {
  if (!address.startsWith('0x') || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatNumber(n: number | bigint, maxFrac = 6): string {
  const num = typeof n === 'bigint' ? Number(n) : n;
  if (!isFinite(num)) return '—';
  return num.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

/**
 * Display formatter for raw token-balance `bigint`s.
 *
 * `formatUnits(value, 18)` returns the full 18-fractional-digit string
 * (e.g. `203998.491649604224447969`), which overflows narrow card
 * layouts and reads as visual noise to humans. This helper picks a
 * sensible fractional-digit budget for the magnitude:
 *
 * - `>= 10000` → 2 digits (whole tokens dominate, clutter wins)
 * - `>= 1`     → 4 digits (typical balance display)
 * - `> 0`      → 6 digits (small claim amounts still readable)
 * - `0`        → "0"
 *
 * Always uses locale-aware grouping so `1217280.99` reads as
 * `1,217,280.99` instead of one long unbroken token.
 */
export function formatTokenBalance(raw: bigint, decimals = 18): string {
  if (raw === 0n) return '0';
  const asString = formatUnits(raw, decimals);
  const n = Number(asString);
  if (!Number.isFinite(n)) return asString;
  const fractionDigits = n >= 10_000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
}
