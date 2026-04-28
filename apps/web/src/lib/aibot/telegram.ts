/**
 * Minimal Telegram Bot API client used by the Etica AI bot.
 *
 * We only need two operations:
 *   1. `getMe()` — to look up the bot's id and username on cold start so
 *      trigger detection can verify `@-mention` slices.
 *   2. `sendMessage()` — to reply in the originating chat.
 *
 * Plain `fetch` keeps the dependency footprint zero (the buybot already
 * follows this pattern in `lib/buybot/telegram.ts`).
 */

export interface BotIdentity {
  id: number;
  username: string;
}

export interface SendMessageOptions {
  /** Reply directly to a specific message, threading the answer in-place. */
  replyToMessageId?: number;
  /** `'HTML'` | `'MarkdownV2'` | undefined (plain text). */
  parseMode?: 'HTML' | 'MarkdownV2';
  /** Suppress link previews — useful when text contains URLs we don't want unfurled. */
  disableWebPagePreview?: boolean;
}

export interface SendMessageResult {
  ok: boolean;
  status: number;
  description?: string;
}

export interface TelegramApi {
  getMe(): Promise<BotIdentity>;
  sendMessage(chatId: number | string, text: string, opts?: SendMessageOptions): Promise<SendMessageResult>;
}

interface GetMeResponse {
  ok: boolean;
  result?: { id: number; username?: string; first_name?: string };
  description?: string;
}

export function telegramApi(botToken: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${botToken}`;

  return {
    async getMe(): Promise<BotIdentity> {
      const res = await fetchImpl(`${base}/getMe`, { cache: 'no-store' });
      const json = (await res.json()) as GetMeResponse;
      if (!json.ok || !json.result) {
        throw new Error(`telegram getMe failed: ${json.description ?? res.status}`);
      }
      const { id, username } = json.result;
      if (typeof username !== 'string' || username.length === 0) {
        throw new Error('telegram getMe returned bot with no username');
      }
      return { id, username };
    },

    async sendMessage(chatId, text, opts = {}) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
      };
      if (opts.replyToMessageId) body.reply_to_message_id = opts.replyToMessageId;
      if (opts.parseMode) body.parse_mode = opts.parseMode;
      if (opts.disableWebPagePreview) body.disable_web_page_preview = true;

      const res = await fetchImpl(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });

      let description: string | undefined;
      try {
        const data = (await res.json()) as { description?: string };
        description = data.description;
      } catch {
        // ignore malformed responses
      }
      return { ok: res.ok, status: res.status, description };
    },
  };
}
