/**
 * Small, dependency-free helpers shared across the keeper.
 */

import { SUN_PER_TRX } from './types.js';

/** ETRX is a standard 18-decimal ERC-20; TRX/SUN has 6 decimals. */
const SUN_TO_ETRX_SCALE = 10n ** 12n;

/** Format SUN as a human-readable TRX string (6 dp, trailing zeros trimmed). */
export function formatTrx(sun: bigint): string {
  const negative = sun < 0n;
  const abs = negative ? -sun : sun;
  const whole = abs / SUN_PER_TRX;
  const frac = (abs % SUN_PER_TRX).toString().padStart(6, '0').replace(/0+$/, '');
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return `${negative ? '-' : ''}${body} TRX`;
}

/**
 * Convert a SUN amount (6 dp) into an 18-decimal ETRX wei amount, preserving
 * the 1:1 TRX↔eTRX backing (1 TRX of revenue mints exactly 1 eTRX).
 */
export function sunToEtrxWei(sun: bigint): bigint {
  return sun * SUN_TO_ETRX_SCALE;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff. Used to ride out
 * transient RPC blips on either chain without crashing the loop.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string; log?: Pick<Console, 'warn'> } = {},
): Promise<T> {
  const { attempts = 3, baseDelayMs = 500, label = 'op', log } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * 2 ** i;
        log?.warn(
          `[retry] ${label} failed (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}
