/**
 * Minimal Telegram alert helper (mirrors apps/bridge-watcher/src/telegram.ts).
 *
 * No-ops when the bot token or chat id are unset, so the keeper runs cleanly
 * before alert secrets are provisioned.
 */

export interface TelegramOptions {
  botToken?: string | null;
  chatId?: string | null;
  silent?: boolean;
}

export async function sendTelegramAlert(
  message: string,
  options: TelegramOptions,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{ posted: boolean; reason?: string }> {
  const { botToken, chatId, silent = false } = options;
  if (!botToken || !chatId) {
    return { posted: false, reason: 'unconfigured' };
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML' as const,
    disable_web_page_preview: true,
    disable_notification: silent,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      log.error(`[telegram] post failed: ${response.status} ${text}`);
      return { posted: false, reason: `http ${response.status}` };
    }
    return { posted: true };
  } catch (err) {
    log.error('[telegram] post threw:', err);
    return { posted: false, reason: 'fetch threw' };
  }
}
