/**
 * POST /api/telegram/webhook
 *
 * Webhook endpoint for the Etica AI Telegram bot. Telegram POSTs every
 * `Update` here; we authenticate it via the secret-token header, verify
 * the chat is on the allowlist, and run the pure trigger detector. When
 * triggered we reply with a canned acknowledgement.
 *
 * This is PR A — the scaffold. Subsequent PRs will:
 *   - PR B: replace the canned response with an LLM-backed answer that
 *     pulls live context from `/api/v1/*` and enforces global per-chat
 *     and per-day USD caps.
 *   - PR C: add short conversation memory + admin commands.
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
import { resolveBotIdentity } from '@/lib/aibot/identity';
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
  /** Telegram-API status from `sendMessage`, useful in logs. */
  send?: { ok: boolean; status: number };
}

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * The canned acknowledgement we return in PR A. Once PR B lands this is
 * replaced with a real LLM-backed answer; for now it lets us validate the
 * full webhook → trigger → reply round-trip end-to-end with no LLM cost.
 */
const CANNED_REPLY = [
  "I'm Etica's AI assistant — currently being wired up.",
  '',
  "I'll be able to answer questions about EticaHub, the Etica chain, ETI/EGAZ/ETX,",
  'staking, farms, and live protocol metrics shortly.',
  '',
  'In the meantime: https://eticahub.com/whitepaper · https://eticahub.com/status',
].join('\n');

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

  const send = await api.sendMessage(message.chat.id, CANNED_REPLY, {
    replyToMessageId: message.message_id,
    disableWebPagePreview: true,
  });

  return ok({
    ok: true,
    triggered: true,
    reason: decision.reason,
    send: { ok: send.ok, status: send.status },
  });
}
