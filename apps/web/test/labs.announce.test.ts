import { describe, expect, it } from 'vitest';

import type { ArchivedResearch } from '@/lib/labs/archive';
import {
  announceDiscovery,
  oauth1Header,
  telegramCaption,
  tweetLength,
  tweetText,
} from '@/lib/labs/announce';

const record: ArchivedResearch = {
  id: 'job-1',
  jobId: 'job-1',
  goalTitle: 'Design a <nanobody> binding the SARS-CoV-2 RBD & blocking ACE2',
  disease: 'COVID-19',
  prompt: 'prompt',
  completedAt: 1_700_000_000_000,
  hypothesis: 'A stabilised CDR3 loop improves affinity.',
  approach: 'ESM + ProteinMPNN',
  bestCandidate: {
    index: 0,
    sequence: 'M'.repeat(120),
    rationale: '',
    score: 0.774,
    folded: true,
    engine: 'esmatlas',
  },
  candidates: [
    {
      index: 0,
      sequence: 'M'.repeat(120),
      rationale: '',
      score: 0.774,
      folded: true,
      engine: 'esmatlas',
    },
    { index: 1, sequence: 'A'.repeat(100), rationale: '', folded: false },
  ],
  iterations: 3,
  summary: '',
  references: [],
  minted: false,
};

function fakeFetch(calls: Array<{ url: string; body: unknown }>, ok = true): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 400 });
  }) as typeof fetch;
}

describe('labs announcer', () => {
  it('renders an HTML-escaped Telegram caption with score, fold count and link', () => {
    const c = telegramCaption(record);
    expect(c).toContain('&lt;nanobody&gt;');
    expect(c).toContain('RBD &amp; blocking');
    expect(c).toContain('<b>77/100</b>');
    expect(c).toContain('1/2 candidates folded');
    expect(c).toContain('/labs/archive/job-1');
  });

  it('keeps tweets within 280 chars (URL counted as 23), even with a huge disease name', () => {
    for (const variant of [
      { ...record, goalTitle: 'x'.repeat(600) },
      { ...record, goalTitle: 'y'.repeat(120), disease: 'd'.repeat(120) },
      { ...record, disease: undefined },
    ]) {
      const t = tweetText(variant);
      expect(t).toMatch(/https?:\/\/\S+/);
      expect(tweetLength(t)).toBeLessThanOrEqual(280);
      expect(t).toContain('#DeSci');
    }
  });

  it('produces a well-formed OAuth 1.0a header', () => {
    const h = oauth1Header(
      'POST',
      'https://api.x.com/2/tweets',
      { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' },
      'nonce',
      '1700000000',
    );
    expect(h.startsWith('OAuth ')).toBe(true);
    expect(h).toContain('oauth_consumer_key="ck"');
    expect(h).toContain('oauth_token="at"');
    expect(h).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(h).toMatch(/oauth_signature="[A-Za-z0-9%]+"/);
  });

  it('posts to Telegram once and skips X when unconfigured; second call is a no-op', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const env = { BUYBOT_TELEGRAM_BOT_TOKEN: 't', BUYBOT_TELEGRAM_CHAT_ID: '-1' };
    const first = await announceDiscovery(record, { env, fetchImpl: fakeFetch(calls) });
    expect(first).toEqual({ telegram: 'sent', x: 'skipped' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/bott/sendPhoto');
    expect((calls[0].body as { photo: string }).photo).toContain(
      '/labs/archive/job-1/opengraph-image',
    );

    const second = await announceDiscovery(record, { env, fetchImpl: fakeFetch(calls) });
    expect(second).toEqual({ telegram: 'skipped', x: 'skipped' });
    expect(calls).toHaveLength(1);
  });

  it('retries a channel that failed, without re-posting one that succeeded', async () => {
    const env = {
      BUYBOT_TELEGRAM_BOT_TOKEN: 't',
      BUYBOT_TELEGRAM_CHAT_ID: '-1',
      X_API_KEY: 'k',
      X_API_SECRET: 's',
      X_ACCESS_TOKEN: 'a',
      X_ACCESS_SECRET: 'b',
    };
    const calls: Array<{ url: string; body: unknown }> = [];
    const xDown = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: String(url).includes('api.x.com') ? 503 : 200 });
    }) as typeof fetch;
    const r = { ...record, id: 'job-retry' };
    expect(await announceDiscovery(r, { env, fetchImpl: xDown })).toEqual({
      telegram: 'sent',
      x: 'failed',
    });

    calls.length = 0;
    expect(await announceDiscovery(r, { env, fetchImpl: fakeFetch(calls) })).toEqual({
      telegram: 'skipped',
      x: 'sent',
    });
    expect(calls.map((c) => c.url)).toEqual(['https://api.x.com/2/tweets']);
  });

  it('falls back to sendMessage when sendPhoto fails', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const env = { LABS_ANNOUNCE_TELEGRAM_BOT_TOKEN: 't', LABS_ANNOUNCE_TELEGRAM_CHAT_ID: '-1' };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const ok = !String(url).includes('sendPhoto');
      return new Response('{}', { status: ok ? 200 : 400 });
    }) as typeof fetch;
    const out = await announceDiscovery({ ...record, id: 'job-2' }, { env, fetchImpl });
    expect(out?.telegram).toBe('sent');
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('does nothing when no channel is configured or nothing folded', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    expect(await announceDiscovery(record, { env: {}, fetchImpl: fakeFetch(calls) })).toBeNull();
    const unfolded = {
      ...record,
      id: 'job-3',
      candidates: record.candidates.map((c) => ({ ...c, folded: false })),
    };
    expect(
      await announceDiscovery(unfolded, {
        env: { BUYBOT_TELEGRAM_BOT_TOKEN: 't', BUYBOT_TELEGRAM_CHAT_ID: '-1' },
        fetchImpl: fakeFetch(calls),
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
