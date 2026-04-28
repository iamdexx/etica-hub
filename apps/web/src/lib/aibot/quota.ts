/**
 * Daily quota enforcement for the Etica AI Telegram bot.
 *
 * Two counters are persisted in KV (Vercel KV / Upstash REST or ioredis-
 * compatible TCP Redis) and reset implicitly via key TTL ~30h after the
 * last write — long enough to outlast UTC midnight rollover but short
 * enough to keep the keyspace bounded.
 *
 *   1. Per-chat reply counter — `<ns>:chat:<chatId>:<utcDate>`
 *      Prevents a single Telegram group from running away with usage.
 *
 *   2. Global USD spend counter — `<ns>:usd:<utcDate>`
 *      Hard ceiling on dollar cost across the whole deployment. With the
 *      default Gemini + Groq free chain this counter never moves; it
 *      only matters once a paid provider (e.g. OpenAI) is appended to
 *      the chain.
 *
 * Counters use Redis INCR / INCRBYFLOAT so they are race-safe across
 * concurrent webhook invocations.
 *
 * When no KV is configured the bot still runs but the caps degrade to
 * "no enforcement" — the operator gets a deploy-time warning, not a
 * runtime error.
 */

import type { AiBotKv } from './kv';

/** UTC date in `YYYY-MM-DD` form. */
export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** TTL on counter keys: 30h covers DST + clock skew + UTC rollover. */
const COUNTER_TTL_SECONDS = 30 * 3600;

function chatKey(namespace: string, chatId: string | number, date: string): string {
  return `${namespace}:chat:${chatId}:${date}`;
}

function usdKey(namespace: string, date: string): string {
  return `${namespace}:usd:${date}`;
}

export interface QuotaCheckArgs {
  kv: AiBotKv | null;
  namespace: string;
  chatId: string | number;
  /** Per-chat per-day cap; 0 = unlimited. */
  chatDailyCap: number;
  /** Per-day USD cap; 0 = unlimited. */
  dailyUsdCap: number;
  now?: Date;
}

export interface QuotaState {
  /** Current per-chat reply count for this UTC day. */
  chatCount: number;
  /** Current global USD spend for this UTC day. */
  usdSpent: number;
  /** Per-chat cap from config (mirrored for convenience). */
  chatDailyCap: number;
  /** Global USD cap from config. */
  dailyUsdCap: number;
  /** True iff the per-chat cap is exhausted. */
  chatCapHit: boolean;
  /** True iff the global USD cap is exhausted. */
  usdCapHit: boolean;
  /** True iff either cap is exhausted (do not call the LLM). */
  anyCapHit: boolean;
}

/** Read both counters and decide whether the LLM call is allowed. */
export async function readQuota(args: QuotaCheckArgs): Promise<QuotaState> {
  const date = utcDateKey(args.now);

  if (!args.kv) {
    return {
      chatCount: 0,
      usdSpent: 0,
      chatDailyCap: args.chatDailyCap,
      dailyUsdCap: args.dailyUsdCap,
      chatCapHit: false,
      usdCapHit: false,
      anyCapHit: false,
    };
  }

  const [chatCount, usdSpent] = await Promise.all([
    args.kv.getNumber(chatKey(args.namespace, args.chatId, date)),
    args.kv.getNumber(usdKey(args.namespace, date)),
  ]);

  const chatCapHit = args.chatDailyCap > 0 && chatCount >= args.chatDailyCap;
  const usdCapHit = args.dailyUsdCap > 0 && usdSpent >= args.dailyUsdCap;

  return {
    chatCount,
    usdSpent,
    chatDailyCap: args.chatDailyCap,
    dailyUsdCap: args.dailyUsdCap,
    chatCapHit,
    usdCapHit,
    anyCapHit: chatCapHit || usdCapHit,
  };
}

export interface RecordUsageArgs {
  kv: AiBotKv | null;
  namespace: string;
  chatId: string | number;
  /** USD cost of the call; pass 0 for free-tier providers. */
  costUsd: number;
  now?: Date;
}

/**
 * Record a single call against the daily counters. No-op if `kv` is null.
 * Returns the new counter values for logging/telemetry.
 */
export async function recordUsage(args: RecordUsageArgs): Promise<{
  chatCount: number;
  usdSpent: number;
}> {
  if (!args.kv) {
    return { chatCount: 0, usdSpent: 0 };
  }
  const date = utcDateKey(args.now);

  const promises: [Promise<number>, Promise<number>] = [
    args.kv.incrCounter(chatKey(args.namespace, args.chatId, date), COUNTER_TTL_SECONDS),
    // Skip the USD counter write entirely when cost is zero (free
    // tier). Saves a round trip on the happy path.
    args.costUsd > 0
      ? args.kv.incrFloat(usdKey(args.namespace, date), args.costUsd, COUNTER_TTL_SECONDS)
      : args.kv.getNumber(usdKey(args.namespace, date)),
  ];
  const [chatCount, usdSpent] = await Promise.all(promises);
  return { chatCount, usdSpent };
}

export const __testing = { COUNTER_TTL_SECONDS, chatKey, usdKey };
