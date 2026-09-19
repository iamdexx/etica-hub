import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTelegramAlert } from '../src/telegram.js';

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sendTelegramAlert', () => {
  it('no-ops when unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendTelegramAlert('hi', { botToken: undefined, chatId: '1' }, silentLog);
    expect(res).toEqual({ posted: false, reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts HTML message to the bot endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendTelegramAlert('<b>x</b>', { botToken: 'tok', chatId: '42', silent: true }, silentLog);
    expect(res).toEqual({ posted: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottok/sendMessage');
    expect(JSON.parse(String(init.body))).toMatchObject({
      chat_id: '42',
      text: '<b>x</b>',
      parse_mode: 'HTML',
      disable_notification: true,
    });
  });

  it('reports http failures without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'slow down' }));
    const res = await sendTelegramAlert('x', { botToken: 't', chatId: 'c' }, silentLog);
    expect(res).toEqual({ posted: false, reason: 'http 429' });
    expect(silentLog.error).toHaveBeenCalled();
  });

  it('reports network errors without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const res = await sendTelegramAlert('x', { botToken: 't', chatId: 'c' }, silentLog);
    expect(res).toEqual({ posted: false, reason: 'fetch threw' });
  });
});
