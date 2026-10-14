/**
 * Minimal Telegram alert helper.
 *
 * Mirrors the buybot's posting style (apps/web/lib/buybot.ts) but is
 * scoped to operator-private alerts on a separate chat than the public
 * announcement channel. If the bot token or chat ID are unset, this
 * helper no-ops — useful for first-deploy CI runs before secrets are
 * provisioned.
 */

export interface TelegramOptions {
  botToken?: string;
  chatId?: string;
  /**
   * If true, sends with `disable_notification` so the alert lands silently.
   * The watcher uses this for routine status logs and reserves loud pings
   * for actual sanity-check failures.
   */
  silent?: boolean;
}

export async function sendTelegramAlert(
  message: string,
  options: TelegramOptions,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{ posted: boolean; reason?: string }> {
  const { botToken, chatId, silent = false } = options;
  if (!botToken || !chatId) {
    log.info('[telegram] skip — bot token or chat id unset');
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
