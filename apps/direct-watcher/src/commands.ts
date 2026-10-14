/**
 * Admin commands over Telegram. Each cron run drains the bot's pending
 * updates (long polling is impossible from a cron), answers commands sent by
 * a configured admin user id, and ignores everyone else. Commands:
 *
 *   /status   current venue snapshot (pause state, windows, LP, findings)
 *   /pause    pause swaps via the guardian key (lapses after guardianPauseDuration)
 *   /help     list commands
 *
 * There is deliberately no /unpause: the guardian key cannot unpause, that
 * is the multisig's call.
 */

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: { id: number; username?: string };
    chat: { id: number };
  };
}

export interface Command {
  updateId: number;
  chatId: number;
  fromId: number;
  fromName: string;
  name: 'status' | 'pause' | 'help';
}

export function parseCommands(updates: TelegramUpdate[], adminIds: number[], botName?: string): Command[] {
  const out: Command[] = [];
  for (const u of updates) {
    const m = u.message;
    const text = m?.text?.trim();
    if (!m || !text || !m.from) continue;
    if (!text.startsWith('/')) continue;
    if (!adminIds.includes(m.from.id)) continue;
    let word = text.split(/\s+/)[0]!.slice(1).toLowerCase();
    const at = word.indexOf('@');
    if (at >= 0) {
      if (botName && word.slice(at + 1) !== botName.toLowerCase()) continue;
      word = word.slice(0, at);
    }
    if (word !== 'status' && word !== 'pause' && word !== 'help') continue;
    out.push({
      updateId: u.update_id,
      chatId: m.chat.id,
      fromId: m.from.id,
      fromName: m.from.username ? `@${m.from.username}` : String(m.from.id),
      name: word,
    });
  }
  return out;
}

export async function fetchUpdates(
  botToken: string,
  afterUpdateId: number | undefined,
  log: Pick<Console, 'warn'> = console,
): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams({ timeout: '0', allowed_updates: '["message"]' });
  if (afterUpdateId !== undefined) params.set('offset', String(afterUpdateId + 1));
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?${params}`);
    if (!res.ok) {
      log.warn(`[telegram] getUpdates failed: ${res.status} ${await res.text()}`);
      return [];
    }
    const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    return body.ok && body.result ? body.result : [];
  } catch (err) {
    log.warn('[telegram] getUpdates threw:', err);
    return [];
  }
}

export const HELP_TEXT = [
  '<b>EticaSwap Direct watcher</b>',
  '/status – venue snapshot: pause state, windows, hub LP, open findings',
  '/pause – pause swaps now via the guardian key (lapses after the guardian pause duration; only the multisig unpauses)',
  '/help – this list',
].join('\n');
