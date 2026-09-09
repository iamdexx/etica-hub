import type { NextRequest } from 'next/server';

/**
 * Is this request a genuine Vercel Cron invocation?
 *
 * When `CRON_SECRET` is configured, Vercel sends it as
 * `Authorization: Bearer <CRON_SECRET>` on every scheduled call and we
 * require an exact match. The `x-vercel-cron` / User-Agent signals are
 * attacker-controllable on public routes, so they are only honoured when no
 * secret is configured (local dev / preview).
 */
export function isVercelCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get('authorization') ?? '';
    return timingSafeEqual(header, `Bearer ${secret}`);
  }
  if (req.headers.get('x-vercel-cron')) return true;
  const ua = req.headers.get('user-agent') ?? '';
  return ua.toLowerCase().includes('vercel-cron');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
