import { describe, expect, it } from 'vitest';
import { decideTrigger, type BotIdentity, type TelegramMessage } from '../src/lib/aibot/triggers';

const BOT: BotIdentity = { id: 12345, username: 'EticaProtocolBot' };
const ALLOWED = new Set(['-1001234567890']);

function msg(overrides: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -1001234567890, type: 'supergroup' },
    from: { id: 999, is_bot: false, username: 'alice' },
    ...overrides,
  };
}

describe('aibot trigger detection', () => {
  it('ignores empty / undefined updates', () => {
    expect(decideTrigger(undefined, BOT, ALLOWED).trigger).toBe(false);
    expect(decideTrigger(msg({ text: '' }), BOT, ALLOWED).trigger).toBe(false);
    expect(decideTrigger(msg({}), BOT, ALLOWED).reason).toBe('no_text');
  });

  it('rejects messages from non-allowlisted chats', () => {
    const m = msg({
      text: '@EticaProtocolBot what is the TVL?',
      chat: { id: -200, type: 'group' },
      entities: [{ type: 'mention', offset: 0, length: 17 }],
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('no_chat_match');
  });

  it('triggers on @username mention with our exact handle', () => {
    const m = msg({
      text: '@EticaProtocolBot what is the TVL?',
      entities: [{ type: 'mention', offset: 0, length: 17 }],
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe('mention');
    expect(result.prompt).toBe('what is the TVL?');
  });

  it('matches @username case-insensitively', () => {
    const m = msg({
      text: '@eticaprotocolbot tell me about ETX',
      entities: [{ type: 'mention', offset: 0, length: 17 }],
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe('mention');
    expect(result.prompt).toBe('tell me about ETX');
  });

  it('does not trigger on a mention of a DIFFERENT bot', () => {
    const m = msg({
      text: '@SomeOtherBot can you check this?',
      entities: [{ type: 'mention', offset: 0, length: 14 }],
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('mention_of_other_bot');
  });

  it('handles a mention in the middle of a sentence', () => {
    const m = msg({
      text: 'hey @EticaProtocolBot — what is APY?',
      entities: [{ type: 'mention', offset: 4, length: 17 }],
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe('mention');
    expect(result.prompt).toBe('hey — what is APY?');
  });

  it('ignores @-strings without an entity (raw text @bot is not a Telegram mention)', () => {
    const m = msg({ text: 'I want to ask @EticaProtocolBot later' });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('no_signal');
  });

  it('triggers on text_mention resolving to our bot user id', () => {
    const m = msg({
      text: 'EticaBot what is the TVL?',
      entities: [
        {
          type: 'text_mention',
          offset: 0,
          length: 8,
          user: { id: BOT.id, username: 'EticaProtocolBot' },
        },
      ],
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe('text_mention');
    expect(result.prompt).toBe('what is the TVL?');
  });

  it('does not trigger on text_mention pointing to a different user', () => {
    const m = msg({
      text: 'Bob what is the TVL?',
      entities: [{ type: 'text_mention', offset: 0, length: 3, user: { id: 999 } }],
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('no_signal');
  });

  it('triggers on a reply to one of our previous messages', () => {
    const m = msg({
      text: 'and what about EGAZ?',
      reply_to_message: { from: { id: BOT.id, username: 'EticaProtocolBot' }, message_id: 100 },
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(true);
    expect(result.reason).toBe('reply_to_bot');
    expect(result.prompt).toBe('and what about EGAZ?');
  });

  it('does not trigger on a reply to a human (or another bot)', () => {
    const m = msg({
      text: 'agreed!',
      reply_to_message: { from: { id: 7777, username: 'someone_else' }, message_id: 50 },
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('no_signal');
  });

  it('ignores reply_to_message with no `from` field (anonymous admin reply)', () => {
    const m = msg({
      text: 'follow-up',
      reply_to_message: { message_id: 50 },
    });
    const result = decideTrigger(m, BOT, ALLOWED);
    expect(result.trigger).toBe(false);
  });
});
