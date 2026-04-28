import { describe, expect, it } from 'vitest';
import { loadAiBotConfig } from '../src/lib/aibot/config';

describe('aibot config loader', () => {
  it('is disabled when token is missing', () => {
    const c = loadAiBotConfig({ AIBOT_ALLOWED_CHAT_IDS: '-100,200' } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
  });

  it('is disabled when allowlist is empty', () => {
    const c = loadAiBotConfig({ AIBOT_TELEGRAM_BOT_TOKEN: '123:abc' } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
  });

  it('is enabled when token + at least one chat id are set', () => {
    const c = loadAiBotConfig({
      AIBOT_TELEGRAM_BOT_TOKEN: '123:abc',
      AIBOT_ALLOWED_CHAT_IDS: '-1001234567890',
    } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(true);
    expect(c.allowedChatIds.has('-1001234567890')).toBe(true);
    expect(c.dailyUsdCap).toBe(5);
    expect(c.chatDailyCap).toBe(1000);
  });

  it('parses comma-separated allowlists with whitespace', () => {
    const c = loadAiBotConfig({
      AIBOT_TELEGRAM_BOT_TOKEN: 't',
      AIBOT_ALLOWED_CHAT_IDS: ' -100, -200 ,  -300',
    } as NodeJS.ProcessEnv);
    expect(c.allowedChatIds.size).toBe(3);
    expect(c.allowedChatIds.has('-100')).toBe(true);
    expect(c.allowedChatIds.has('-200')).toBe(true);
    expect(c.allowedChatIds.has('-300')).toBe(true);
  });

  it('strips a leading @ from AIBOT_USERNAME', () => {
    const c = loadAiBotConfig({
      AIBOT_TELEGRAM_BOT_TOKEN: 't',
      AIBOT_ALLOWED_CHAT_IDS: '-100',
      AIBOT_USERNAME: '@EticaProtocolBot',
    } as NodeJS.ProcessEnv);
    expect(c.botUsername).toBe('EticaProtocolBot');
  });

  it('respects custom caps', () => {
    const c = loadAiBotConfig({
      AIBOT_TELEGRAM_BOT_TOKEN: 't',
      AIBOT_ALLOWED_CHAT_IDS: '-100',
      AIBOT_CHAT_DAILY_CAP: '500',
      AIBOT_DAILY_USD_CAP: '2.5',
    } as NodeJS.ProcessEnv);
    expect(c.chatDailyCap).toBe(500);
    expect(c.dailyUsdCap).toBe(2.5);
  });

  it('rejects malformed integer caps', () => {
    expect(() =>
      loadAiBotConfig({
        AIBOT_TELEGRAM_BOT_TOKEN: 't',
        AIBOT_ALLOWED_CHAT_IDS: '-100',
        AIBOT_CHAT_DAILY_CAP: '-5',
      } as NodeJS.ProcessEnv),
    ).toThrow(/AIBOT_CHAT_DAILY_CAP/);
  });

  it('rejects malformed float caps', () => {
    expect(() =>
      loadAiBotConfig({
        AIBOT_TELEGRAM_BOT_TOKEN: 't',
        AIBOT_ALLOWED_CHAT_IDS: '-100',
        AIBOT_DAILY_USD_CAP: 'not-a-number',
      } as NodeJS.ProcessEnv),
    ).toThrow(/AIBOT_DAILY_USD_CAP/);
  });

  it('treats empty webhook secret as null', () => {
    const c = loadAiBotConfig({
      AIBOT_TELEGRAM_BOT_TOKEN: 't',
      AIBOT_ALLOWED_CHAT_IDS: '-100',
      AIBOT_WEBHOOK_SECRET_TOKEN: '',
    } as NodeJS.ProcessEnv);
    expect(c.webhookSecretToken).toBeNull();
  });
});
