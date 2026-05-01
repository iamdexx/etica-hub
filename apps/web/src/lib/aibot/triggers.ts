/**
 * Pure trigger detection for the Etica AI Telegram bot.
 *
 * The bot must respond ONLY when:
 *   (1) it is `@`-mentioned in a message that the bot can read, or
 *   (2) a message is a direct reply to one of the bot's previous messages.
 *
 * Anything else (regular chatter, mentions of OTHER bots, replies to
 * humans) must be silently ignored. Keeping this logic pure and isolated
 * makes it trivially testable.
 *
 * Telegram's `Update` object has many shapes; we only care about the
 * minimum surface needed for trigger detection. Types are intentionally
 * narrow so the test fixtures stay readable.
 */

export type EntityType =
  | 'mention'
  | 'text_mention'
  | 'bot_command'
  | 'url'
  | 'email'
  | 'hashtag'
  | 'cashtag'
  | 'phone_number'
  | 'bold'
  | 'italic'
  | 'code'
  | 'pre'
  | 'text_link'
  | 'spoiler'
  | (string & {});

export interface MessageEntity {
  type: EntityType;
  offset: number;
  length: number;
  /** Set when `type === 'text_mention'` and the user has no @username. */
  user?: { id: number; username?: string };
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: MessageEntity[];
  /**
   * Set when the user is replying to a previous message. Carries the
   * sender + body text so the webhook can quote the original message
   * back to the model when the user @-mentions the bot in a reply
   * (e.g. "@EticaAI_BOT how do you interpret this?" attached to
   * someone else's BIO post). Telegram trims rich content into `text`
   * for plain messages and `caption` for media; we accept either so
   * media-with-caption replies still surface their context.
   */
  reply_to_message?: {
    from?: TelegramUser;
    message_id: number;
    text?: string;
    caption?: string;
  };
}

export interface BotIdentity {
  id: number;
  username: string;
}

export interface TriggerDecision {
  /** Whether the bot should attempt to answer this message. */
  trigger: boolean;
  /** Why we triggered (or why we didn't). Useful for observability. */
  reason:
    | 'mention'
    | 'text_mention'
    | 'reply_to_bot'
    | 'no_text'
    | 'no_chat_match'
    | 'no_signal'
    | 'mention_of_other_bot';
  /**
   * The user's question with any leading bot mention stripped out.
   * Only set when `trigger === true`. Empty string is allowed (e.g. user
   * just sent `@bot`); callers can decide whether to prompt for a question.
   */
  prompt?: string;
}

/**
 * Decide whether a Telegram update should trigger a bot response.
 *
 * @param msg the Telegram message (typically `update.message`)
 * @param bot the bot's identity (id + lowercased username)
 * @param allowedChatIds set of chat IDs (as strings) the bot may respond in;
 *        any other chat short-circuits to `no_chat_match`.
 */
export function decideTrigger(
  msg: TelegramMessage | undefined,
  bot: BotIdentity,
  allowedChatIds: ReadonlySet<string>,
): TriggerDecision {
  if (!msg || typeof msg.text !== 'string' || msg.text.length === 0) {
    return { trigger: false, reason: 'no_text' };
  }
  if (!allowedChatIds.has(String(msg.chat.id))) {
    return { trigger: false, reason: 'no_chat_match' };
  }

  // Reply-to-bot: a regular user replied to one of our messages.
  if (msg.reply_to_message?.from?.id === bot.id) {
    return { trigger: true, reason: 'reply_to_bot', prompt: msg.text.trim() };
  }

  const text = msg.text;
  const lowerUsername = bot.username.toLowerCase();
  const entities = msg.entities ?? [];

  // text_mention: Telegram resolved a click-mention to our bot's user id
  // even though we may not have a public @username (rare for bots, but
  // supported and we should honor it).
  for (const e of entities) {
    if (e.type === 'text_mention' && e.user?.id === bot.id) {
      const prompt = stripRange(text, e.offset, e.length).trim();
      return { trigger: true, reason: 'text_mention', prompt };
    }
  }

  // mention: classic `@username` reference. We must verify the slice
  // matches OUR username — chats often @-mention other bots, and we
  // must not respond to those.
  let mentionedOtherBot = false;
  for (const e of entities) {
    if (e.type !== 'mention') continue;
    const slice = text.slice(e.offset, e.offset + e.length);
    if (slice.toLowerCase() === `@${lowerUsername}`) {
      const prompt = stripRange(text, e.offset, e.length).trim();
      return { trigger: true, reason: 'mention', prompt };
    }
    mentionedOtherBot = true;
  }

  if (mentionedOtherBot) {
    return { trigger: false, reason: 'mention_of_other_bot' };
  }
  return { trigger: false, reason: 'no_signal' };
}

/**
 * Remove a UTF-16 range from a string. Telegram entity offsets are
 * counted in UTF-16 code units (per the API docs), which matches
 * JavaScript's native string indexing.
 */
function stripRange(text: string, offset: number, length: number): string {
  return (text.slice(0, offset) + text.slice(offset + length)).replace(/\s+/g, ' ');
}
