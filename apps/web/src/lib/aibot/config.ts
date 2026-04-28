/**
 * Runtime configuration for the Etica AI Telegram bot
 * (`/api/telegram/webhook`).
 *
 * The bot is a webhook-driven Q&A assistant for the Etica community
 * Telegram group(s). It only replies when:
 *   1. Directly @-mentioned (e.g. `@EticaProtocolBot what's the TVL?`), or
 *   2. A user replies to one of its own previous messages.
 *
 * All knobs are env-driven. PR A wires the trigger logic and an
 * allowlist; PR B (this) wires the LLM provider chain (Gemini primary +
 * Groq fallback by default), live `/api/v1/*` context grounding, and
 * the global per-chat / per-day USD caps. PR C will add conversation
 * memory and admin commands.
 */

/** Identifier slug for an LLM provider. Used as the env-var prefix. */
export type LlmProviderId = 'gemini' | 'groq' | 'openai' | 'mistral' | 'openrouter' | (string & {});

export interface LlmProviderConfig {
  /** Provider slug, e.g. `gemini`. Lowercased and validated. */
  id: LlmProviderId;
  /** Bearer-token API key for the provider's chat-completions endpoint. */
  apiKey: string;
  /**
   * OpenAI-compatible chat-completions base URL. Every provider we
   * support exposes `<base>/chat/completions`; we just swap the prefix.
   */
  baseUrl: string;
  /** Model id passed in the `model` field of the chat-completions payload. */
  model: string;
  /** Input price per million tokens, in USD (free tiers default to 0). */
  inputPriceUsdPerM: number;
  /** Output price per million tokens, in USD (free tiers default to 0). */
  outputPriceUsdPerM: number;
}

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
   * the LLM until the next day.
   */
  chatDailyCap: number;
  /**
   * Hard USD ceiling per UTC day across the entire deployment. When the
   * accumulated LLM cost exceeds this value the bot replies with a quota
   * notice. With the default Gemini + Groq free-tier chain the per-call
   * cost is $0, so the cap effectively only kicks in when the operator
   * adds a paid provider (e.g. OpenAI) to the chain.
   */
  dailyUsdCap: number;
  /**
   * Bot username (without the leading `@`). PR A only uses this to detect
   * `@username` mentions when Telegram doesn't surface a `mention` entity
   * (e.g. older clients). When unset, mention detection falls back to the
   * `getMe()` API on first request.
   */
  botUsername: string | null;
  /**
   * Ordered list of LLM providers. The webhook calls them in order; the
   * first provider that returns a non-error response wins. Empty list =>
   * no LLM call (`enabledLlm` is false). Default chain when none of the
   * provider envs are set is empty (the bot still authenticates webhooks
   * and runs trigger detection, but tells the user the LLM is offline).
   */
  llmProviders: LlmProviderConfig[];
  /** Convenience: at least one provider configured? */
  enabledLlm: boolean;
  /** Optional Vercel-KV REST URL. Required to persist daily-cap counters. */
  kvRestUrl: string | null;
  /** Optional Vercel-KV REST token. Required alongside `kvRestUrl`. */
  kvRestToken: string | null;
  /** Optional ioredis-compatible TCP url (`redis://...`/`rediss://...`). */
  redisUrl: string | null;
  /** KV key namespace, e.g. `aibot:prod`. */
  kvNamespace: string;
}

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string; inputPrice: number; outputPrice: number }> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // gemini-1.5-flash was retired by Google; gemini-2.5-flash is the
    // current free-tier default and the only one ListModels returns
    // under the OpenAI compatibility surface.
    model: 'gemini-2.5-flash',
    inputPrice: 0,
    outputPrice: 0,
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    inputPrice: 0,
    outputPrice: 0,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    // gpt-4o-mini is the cheapest competent OpenAI model as of 2025;
    // operators can override via AIBOT_LLM_OPENAI_MODEL.
    model: 'gpt-4o-mini',
    inputPrice: 0.15,
    outputPrice: 0.6,
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    inputPrice: 0,
    outputPrice: 0,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    // Empty default forces the operator to pick a model — OpenRouter
    // routes hundreds and we shouldn't pin one silently.
    model: '',
    inputPrice: 0,
    outputPrice: 0,
  },
};

function parseAllowList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function parseProviderChain(raw: string | undefined): string[] {
  if (!raw) return ['gemini', 'groq'];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
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

function envFor(env: NodeJS.ProcessEnv, providerId: string, suffix: string): string | undefined {
  return env[`AIBOT_LLM_${providerId.toUpperCase()}_${suffix}`];
}

function buildProvider(
  env: NodeJS.ProcessEnv,
  id: string,
): LlmProviderConfig | null {
  const apiKey = envFor(env, id, 'API_KEY')?.trim() ?? '';
  if (apiKey.length === 0) return null;

  const defaults = PROVIDER_DEFAULTS[id];
  const baseUrl = (envFor(env, id, 'BASE_URL')?.trim() || defaults?.baseUrl || '').replace(/\/$/, '');
  if (baseUrl.length === 0) {
    throw new Error(
      `AIBOT_LLM_${id.toUpperCase()}_BASE_URL is required for unknown provider "${id}"`,
    );
  }
  const model = envFor(env, id, 'MODEL')?.trim() || defaults?.model || '';
  if (model.length === 0) {
    throw new Error(
      `AIBOT_LLM_${id.toUpperCase()}_MODEL is required for provider "${id}" (no built-in default)`,
    );
  }

  return {
    id,
    apiKey,
    baseUrl,
    model,
    inputPriceUsdPerM: parseFloatNonNeg(
      envFor(env, id, 'INPUT_PRICE_USD_PER_M'),
      defaults?.inputPrice ?? 0,
      `AIBOT_LLM_${id.toUpperCase()}_INPUT_PRICE_USD_PER_M`,
    ),
    outputPriceUsdPerM: parseFloatNonNeg(
      envFor(env, id, 'OUTPUT_PRICE_USD_PER_M'),
      defaults?.outputPrice ?? 0,
      `AIBOT_LLM_${id.toUpperCase()}_OUTPUT_PRICE_USD_PER_M`,
    ),
  };
}

/**
 * Parse the AI bot config from env vars. Always returns a config object,
 * even when secrets are missing — callers consult `enabled` and
 * `enabledLlm` to decide whether to attempt outbound calls. This lets
 * the webhook route no-op gracefully on preview deployments without
 * secrets.
 */
export function loadAiBotConfig(env: NodeJS.ProcessEnv = process.env): AiBotConfig {
  const token = env.AIBOT_TELEGRAM_BOT_TOKEN ?? '';
  const allowed = parseAllowList(env.AIBOT_ALLOWED_CHAT_IDS);
  const secret = env.AIBOT_WEBHOOK_SECRET_TOKEN ?? '';
  const username = (env.AIBOT_USERNAME ?? '').trim().replace(/^@/, '');

  const chain = parseProviderChain(env.AIBOT_LLM_PROVIDERS);
  const providers: LlmProviderConfig[] = [];
  for (const id of chain) {
    const p = buildProvider(env, id);
    if (p) providers.push(p);
  }

  const kvUrl = (env.AIBOT_KV_REST_URL || env.KV_REST_API_URL || '').trim();
  const kvToken = (env.AIBOT_KV_REST_TOKEN || env.KV_REST_API_TOKEN || '').trim();
  const redisUrl = (env.AIBOT_REDIS_URL || env.REDIS_URL || '').trim();
  const namespace = (env.AIBOT_KV_NAMESPACE || 'aibot:prod').trim();

  return {
    enabled: token.length > 0 && allowed.size > 0,
    telegramBotToken: token,
    webhookSecretToken: secret.length > 0 ? secret : null,
    allowedChatIds: allowed,
    chatDailyCap: parseInteger(env.AIBOT_CHAT_DAILY_CAP, 1000, 'AIBOT_CHAT_DAILY_CAP'),
    dailyUsdCap: parseFloatNonNeg(env.AIBOT_DAILY_USD_CAP, 5, 'AIBOT_DAILY_USD_CAP'),
    botUsername: username.length > 0 ? username : null,
    llmProviders: providers,
    enabledLlm: providers.length > 0,
    kvRestUrl: kvUrl.length > 0 ? kvUrl : null,
    kvRestToken: kvToken.length > 0 ? kvToken : null,
    redisUrl: redisUrl.length > 0 ? redisUrl : null,
    kvNamespace: namespace,
  };
}
