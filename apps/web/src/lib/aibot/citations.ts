/**
 * Citation footer rendering for the Etica AI Telegram bot.
 *
 * When Gemini answers with Google Search grounding enabled, the
 * `groundingChunks` array on the response carries the source URLs the
 * model leaned on. We render those as a compact footer so users (and
 * admins reviewing chat logs) can see where the real-time facts came
 * from. Footer is intentionally terse — Telegram messages are short,
 * and a wall of "Sources:" links would dominate the reply.
 */

import type { ChatCitation } from './llm';

export interface CitationFooterOptions {
  /** Maximum number of sources to render. Defaults to 5. */
  maxSources?: number;
  /** Maximum visible characters per title before truncation. Defaults to 60. */
  maxTitleChars?: number;
}

/**
 * Build a Telegram-friendly "Sources" footer from a list of citations.
 * Returns an empty string when there are no citations, so callers can
 * unconditionally concat without producing a stray header.
 *
 * Format (intentionally plain text, not HTML/Markdown — Telegram
 * `sendMessage` is being called without `parse_mode` and we don't want
 * to escape every URL):
 *
 *   Sources:
 *   • Title — https://example.com/path
 *   • Title 2 — https://example.org/path
 */
export function renderCitationFooter(
  citations: ChatCitation[],
  opts: CitationFooterOptions = {},
): string {
  if (citations.length === 0) return '';

  const maxSources = opts.maxSources ?? 5;
  const maxTitleChars = opts.maxTitleChars ?? 60;

  const lines: string[] = ['', 'Sources:'];
  const limited = citations.slice(0, Math.max(0, maxSources));
  for (const c of limited) {
    const title = c.title.length > maxTitleChars
      ? `${c.title.slice(0, maxTitleChars - 1).trimEnd()}…`
      : c.title;
    lines.push(`• ${title} — ${c.url}`);
  }
  return lines.join('\n');
}
