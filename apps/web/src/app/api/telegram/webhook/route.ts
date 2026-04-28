/**
 * POST /api/telegram/webhook
 *
 * Webhook endpoint for the Etica AI Telegram bot. Telegram POSTs every
 * `Update` here; we authenticate it via the secret-token header, verify
 * the chat is on the allowlist, and run the pure trigger detector. When
 * triggered we call the LLM provider chain (Gemini primary + Groq
 * fallback by default), grounded in live `/api/v1/*` data, and reply
 * inline.
 *
 * The bot is designed to work as either an admin OR a regular non-admin
 * member of a group. With Telegram's default `bot_privacy=enabled`, a
 * non-admin bot only receives messages that already match our trigger
 * criteria (mentions + replies), so we don't need elevated permissions.
 *
 * Telegram requires a 2xx response within ~10 seconds even on no-op
 * updates; we always respond `200 ok` and only do meaningful work after
 * confirming the trigger.
 */

import { NextRequest } from 'next/server';

import { loadAiBotConfig, type AiBotConfig } from '@/lib/aibot/config';
import { fetchLiveContext } from '@/lib/aibot/context';
import { resolveBotIdentity } from '@/lib/aibot/identity';
import { aiBotKvFor } from '@/lib/aibot/kv';
import { runChatChain } from '@/lib/aibot/llm';
import { buildChatMessages } from '@/lib/aibot/prompt';
import { readQuota, recordUsage } from '@/lib/aibot/quota';
import { telegramApi } from '@/lib/aibot/telegram';
import { decideTrigger, type TelegramMessage, type TriggerDecision } from '@/lib/aibot/triggers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface WebhookResult {
  ok: boolean;
  triggered?: boolean;
  reason?: TriggerDecision['reason'];
  /** Set when the webhook short-circuited before reaching trigger logic. */
  skipped?: 'disabled' | 'forbidden' | 'invalid_payload' | 'no_message';
  /** What we did once triggered: replied with LLM, with a quota notice, etc. */
  action?: 'llm' | 'quota_chat' | 'quota_usd' | 'llm_unavailable' | 'empty_question' | 'llm_failed';
  /** Provider that produced the final reply, if any. */
  provider?: string | null;
  /** Telegram-API status from `sendMessage`, useful in logs. */
  send?: { ok: boolean; status: number };
}

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const QUOTA_REPLY_CHAT =
  "I've answered the maximum number of questions for this group today. " +
  "Ping me again after UTC midnight.";

const QUOTA_REPLY_USD =
  "I've hit my daily spending budget. I'll be back after UTC midnight.";

const LLM_OFFLINE_REPLY =
  "I'm online but my LLM provider isn't configured yet. " +
  'Check https://eticahub.com/status for protocol metrics in the meantime.';

const LLM_FAILED_REPLY =
  "I tried to answer but every model provider failed right now. " +
  'Try again in a few minutes.';

const EMPTY_QUESTION_REPLY =
  "I see the mention but no question — ask me something about Etica, EticaHub, " +
  'staking, farms, or live protocol metrics.';

function ok(body: WebhookResult): Response {
  // Always 200 OK — Telegram interprets non-2xx as a delivery failure
  // and will retry, which we don't want.
  return Response.json(body, { status: 200 });
}

function authenticated(req: NextRequest, config: AiBotConfig): boolean {
  if (!config.webhookSecretToken) return true; // not configured → accept (preview)
  return req.headers.get(SECRET_HEADER) === config.webhookSecretToken;
}

function pickMessage(update: TelegramUpdate): TelegramMessage | undefined {
  // We answer normal messages and channel posts. We do NOT answer
  // edited messages — replying to an edit creates a confusing UX where
  // the bot answers a question the user has already changed.
  return update.message ?? update.channel_post ?? undefined;
}

function originForLiveContext(req: NextRequest): string {
  // In production Vercel sets `VERCEL_URL` to the per-deployment hostname.
  // For local dev / fallback we read the request's origin.
  const explicit = process.env.AIBOT_API_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return new URL(req.url).origin;
}

export async function POST(req: NextRequest): Promise<Response> {
  const config = loadAiBotConfig();

  if (!config.enabled) {
    return ok({ ok: true, skipped: 'disabled' });
  }
  if (!authenticated(req, config)) {
    return ok({ ok: false, skipped: 'forbidden' });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return ok({ ok: false, skipped: 'invalid_payload' });
  }

  const message = pickMessage(update);
  if (!message) {
    return ok({ ok: true, skipped: 'no_message' });
  }

  const api = telegramApi(config.telegramBotToken);
  const bot = await resolveBotIdentity(api);
  const decision = decideTrigger(message, bot, config.allowedChatIds);

  if (!decision.trigger) {
    return ok({ ok: true, triggered: false, reason: decision.reason });
  }

  const question = (decision.prompt ?? '').trim();
  if (question.length === 0) {
    const send = await api.sendMessage(message.chat.id, EMPTY_QUESTION_REPLY, {
      replyToMessageId: message.message_id,
      disableWebPagePreview: true,
    });
    return ok({
      ok: true,
      triggered: true,
      reason: decision.reason,
      action: 'empty_question',
      send: { ok: send.ok, status: send.status },
    });
  }

  if (!config.enabledLlm) {
    const send = await api.sendMessage(message.chat.id, LLM_OFFLINE_REPLY, {
      replyToMessageId: message.message_id,
      disableWebPagePreview: true,
    });
    return ok({
      ok: true,
      triggered: true,
      reason: decision.reason,
      action: 'llm_unavailable',
      send: { ok: send.ok, status: send.status },
    });
  }

  const kv = aiBotKvFor(config);
  const quota = await readQuota({
    kv,
    namespace: config.kvNamespace,
    chatId: message.chat.id,
    chatDailyCap: config.chatDailyCap,
    dailyUsdCap: config.dailyUsdCap,
  });

  if (quota.chatCapHit) {
    const send = await api.sendMessage(message.chat.id, QUOTA_REPLY_CHAT, {
      replyToMessageId: message.message_id,
      disableWebPagePreview: true,
    });
    return ok({
      ok: true,
      triggered: true,
      reason: decision.reason,
      action: 'quota_chat',
      send: { ok: send.ok, status: send.status },
    });
  }
  if (quota.usdCapHit) {
    const send = await api.sendMessage(message.chat.id, QUOTA_REPLY_USD, {
      replyToMessageId: message.message_id,
      disableWebPagePreview: true,
    });
    return ok({
      ok: true,
      triggered: true,
      reason: decision.reason,
      action: 'quota_usd',
      send: { ok: send.ok, status: send.status },
    });
  }

  const baseUrl = originForLiveContext(req);
  const liveContext = await fetchLiveContext({ baseUrl });
  const messages = buildChatMessages({ question, contextText: liveContext.text });
  const result = await runChatChain(config.llmProviders, { messages });

  if (!result.ok) {
    const send = await api.sendMessage(message.chat.id, LLM_FAILED_REPLY, {
      replyToMessageId: message.message_id,
      disableWebPagePreview: true,
    });
    return ok({
      ok: true,
      triggered: true,
      reason: decision.reason,
      action: 'llm_failed',
      provider: result.provider,
      send: { ok: send.ok, status: send.status },
    });
  }

  // Record usage *before* posting the reply so a Telegram failure
  // doesn't leak free LLM calls. Cost is 0 for free-tier providers, so
  // the USD counter only ticks when a paid provider answers.
  await recordUsage({
    kv,
    namespace: config.kvNamespace,
    chatId: message.chat.id,
    costUsd: result.costUsd,
  });

  const send = await api.sendMessage(message.chat.id, result.text, {
    replyToMessageId: message.message_id,
    disableWebPagePreview: true,
  });

  return ok({
    ok: true,
    triggered: true,
    reason: decision.reason,
    action: 'llm',
    provider: result.provider,
    send: { ok: send.ok, status: send.status },
  });
}
