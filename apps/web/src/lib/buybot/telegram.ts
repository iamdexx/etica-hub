/**
 * Minimal Telegram Bot API client used by the buy-bot cron.
 *
 * We don't need streaming updates or command handling — just `sendMessage`
 * via the public HTTP endpoint. Using plain `fetch` avoids adding a
 * `node-telegram-bot-api` / `grammy` dependency for one call.
 */

import type { FormattedBuy } from './format';

export interface TelegramSendResult {
  ok: boolean;
  status: number;
  description?: string;
}

export interface TelegramClient {
  sendMessage(msg: FormattedBuy): Promise<TelegramSendResult>;
}

export function telegramClient(
  botToken: string,
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return {
    async sendMessage(msg) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg.text,
          parse_mode: msg.parseMode,
          disable_web_page_preview: msg.disableWebPreview,
        }),
        cache: 'no-store',
      });
      let description: string | undefined;
      try {
        const body = (await res.json()) as { description?: string };
        description = body.description;
      } catch {
        // ignore
      }
      return { ok: res.ok, status: res.status, description };
    },
  };
}
