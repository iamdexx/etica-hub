/**
 * Runtime configuration for the Etica AI Telegram bot
 * (`/api/telegram/webhook`).
 *
 * The bot is a webhook-driven Q&A assistant for the Etica community
 * Telegram group(s). It only replies when:
 *   1. Directly @-mentioned (e.g. `@EticaProtocolBot what's the TVL?`), or
 *   2. A user replies to one of its own previous messages.
 *
 * All knobs are env-driven. PR A (this scaffold) wires the trigger logic
 * and an allowlist; PR B wires the LLM; PR C wires conversation memory
 * and admin commands.
 */

export interface AiBotConfig {
  /** Whether the bot is configured well enough to attempt a response. */
  enabled: boolean;
  /** Telegram bot token from BotFather, used for outbound `sendMessage`. */
  telegramBotToken: string;
  /**
   * Optional secret token shared between Telegram and our webhook (set via
   * `setWebhook?secret_token=...`). When present, every incoming update
   * MUST include the matching `X-Telegram-Bot-Api-Secret-Token` header or
   * we reject it. This is Telegram's recommended way to authenticate
   * webhook calls and prevents anyone on the public internet from
   * impersonating Telegram.
   */
  webhookSecretToken: string | null;
  /**
   * Comma-separated list of chat IDs (numeric, usually negative for groups)
   * the bot is allowed to respond in. Updates from any other chat are
   * silently ignored — even if someone adds the bot to their own group,
   * it will never reply there.
   */
  allowedChatIds: ReadonlySet<string>;
  /**
   * Maximum number of LLM-backed replies allowed per chat per UTC day.
   * Once exceeded the bot replies with a quota notice and stops calling
   * the LLM until the next day. Wired in PR B; surfaced here so PR A's
   * config object is forward-compatible.
   */
  chatDailyCap: number;
  /**
   * Hard USD ceiling per UTC day across the entire deployment. When the
   * accumulated LLM cost exceeds this value the bot replies with a quota
   * notice. Wired in PR B.
   */
  dailyUsdCap: number;
  /**
   * Bot username (without the leading `@`). PR A only uses this to detect
   * `@username` mentions when Telegram doesn't surface a `mention` entity
   * (e.g. older clients). When unset, mention detection falls back to the
   * `getMe()` API on first request.
   */
  botUsername: string | null;
}

function parseAllowList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function parseInteger(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}

function parseFloatNonNeg(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number, got: ${raw}`);
  }
  return n;
}

/**
 * Parse the AI bot config from env vars. Always returns a config object,
 * even when secrets are missing — callers consult `enabled` to decide
 * whether to attempt outbound calls. This lets the webhook route no-op
 * gracefully on preview deployments without secrets.
 */
export function loadAiBotConfig(env: NodeJS.ProcessEnv = process.env): AiBotConfig {
  const token = env.AIBOT_TELEGRAM_BOT_TOKEN ?? '';
  const allowed = parseAllowList(env.AIBOT_ALLOWED_CHAT_IDS);
  const secret = env.AIBOT_WEBHOOK_SECRET_TOKEN ?? '';
  const username = (env.AIBOT_USERNAME ?? '').trim().replace(/^@/, '');

  return {
    enabled: token.length > 0 && allowed.size > 0,
    telegramBotToken: token,
    webhookSecretToken: secret.length > 0 ? secret : null,
    allowedChatIds: allowed,
    chatDailyCap: parseInteger(env.AIBOT_CHAT_DAILY_CAP, 1000, 'AIBOT_CHAT_DAILY_CAP'),
    dailyUsdCap: parseFloatNonNeg(env.AIBOT_DAILY_USD_CAP, 5, 'AIBOT_DAILY_USD_CAP'),
    botUsername: username.length > 0 ? username : null,
  };
}
