/**
 * Telegram message chunking for the Etica AI bot.
 *
 * Telegram silently truncates outbound `sendMessage` payloads at 4096
 * UTF-16 code units. The bot's LLM replies can exceed that — long-form
 * answers like "explain how X system works" routinely run past the limit
 * — so we split them into multiple messages before sending.
 *
 * Splitting strategy (greedy, prefers larger semantic boundaries):
 *   1. Try to break at paragraph (`\n\n`) boundaries.
 *   2. Failing that, break at single newlines.
 *   3. Failing that, break at the last whitespace within the budget.
 *   4. Last resort: hard-cut mid-word at the budget.
 *
 * We use a slightly conservative budget (3900 by default) instead of the
 * 4096 hard limit so emoji or surrogate pairs that count double-wide in
 * Telegram's UTF-16 view never tip a chunk over the wire limit.
 */

/** Default per-chunk character budget. Conservative against UTF-16 surprises. */
export const TELEGRAM_CHUNK_LIMIT = 3900;

export interface ChunkOptions {
  /** Max characters per chunk. Defaults to {@link TELEGRAM_CHUNK_LIMIT}. */
  limit?: number;
}

/**
 * Split `text` into one or more chunks each no longer than `limit`. The
 * returned array is non-empty for any non-empty input (an empty input
 * returns an empty array — caller must decide whether to send anything).
 */
export function chunkForTelegram(text: string, opts: ChunkOptions = {}): string[] {
  const limit = opts.limit ?? TELEGRAM_CHUNK_LIMIT;
  if (limit <= 0) {
    throw new Error(`chunkForTelegram: limit must be positive, got ${limit}`);
  }

  const trimmed = text.replace(/\s+$/u, '');
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const out: string[] = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);

    // 1. Paragraph break — prefer a clean blank-line boundary.
    let cut = slice.lastIndexOf('\n\n');
    // 2. Fall back to a single newline.
    if (cut === -1) cut = slice.lastIndexOf('\n');
    // 3. Fall back to the last whitespace.
    if (cut === -1) {
      const ws = slice.match(/\s[^\s]*$/u);
      if (ws && typeof ws.index === 'number') cut = ws.index;
    }
    // 4. Last resort: hard cut at the budget.
    if (cut <= 0) cut = limit;

    out.push(remaining.slice(0, cut).replace(/\s+$/u, ''));
    remaining = remaining.slice(cut).replace(/^\s+/u, '');
  }

  if (remaining.length > 0) out.push(remaining);
  return out;
}
