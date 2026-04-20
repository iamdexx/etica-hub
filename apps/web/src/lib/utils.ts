import { clsx, type ClassValue } from 'clsx';
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
