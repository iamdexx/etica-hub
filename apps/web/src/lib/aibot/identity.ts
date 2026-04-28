/**
 * Cached lookup of the bot's identity (`id` + `username`).
 *
 * Telegram's `getMe` endpoint never changes for a given token, so we cache
 * the result in module scope to avoid an extra HTTP round-trip on every
 * webhook invocation. In a serverless environment this cache is per-cold-
 * start, which is exactly the right granularity — short-lived enough to
 * pick up a bot rename within minutes, persistent enough to amortize the
 * lookup across all subsequent invocations of the same instance.
 */

import type { TelegramApi, BotIdentity } from './telegram';

let cached: BotIdentity | null = null;

/**
 * Resolve the bot's identity. If a username is provided via env
 * (`AIBOT_USERNAME`), we still call `getMe` to learn the numeric id
 * (which is required for reply-to-bot detection).
 */
export async function resolveBotIdentity(api: TelegramApi): Promise<BotIdentity> {
  if (cached) return cached;
  cached = await api.getMe();
  return cached;
}

/** Test-only hook to reset the module-level cache. */
export function __resetBotIdentityCache(): void {
  cached = null;
}
