import { describe, expect, it, vi } from 'vitest';
import type { LlmProviderConfig } from '../src/lib/aibot/config';
import { runChatChain } from '../src/lib/aibot/llm';

function provider(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id: 'gemini',
    apiKey: 'k',
    baseUrl: 'https://example.com/v1',
    model: 'm',
    inputPriceUsdPerM: 0,
    outputPriceUsdPerM: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const okBody = (text: string, prompt = 100, completion = 50) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
  model: 'whatever',
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

describe('aibot llm chain', () => {
  it('returns failure when no providers are configured', async () => {
    const fetchImpl = vi.fn();
    const res = await runChatChain([], { messages: [{ role: 'user', content: 'hi' }] }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (!res.ok) {
      expect(res.reason).toMatch(/no providers/i);
    }
  });

  it('uses the first provider that succeeds and stops there', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody('hello world')));
    const res = await runChatChain(
      [provider({ id: 'gemini' }), provider({ id: 'groq' })],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (res.ok) {
      expect(res.provider).toBe('gemini');
      expect(res.text).toBe('hello world');
      expect(res.costUsd).toBe(0);
    }
  });

  it('falls back to the next provider on HTTP 429', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limit' } }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(okBody('from groq')));
    const res = await runChatChain(
      [provider({ id: 'gemini' }), provider({ id: 'groq' })],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    if (res.ok) {
      expect(res.provider).toBe('groq');
    }
  });

  it('falls back when the primary throws (network error)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(okBody('back online')));
    const res = await runChatChain(
      [provider({ id: 'gemini' }), provider({ id: 'groq' })],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.provider).toBe('groq');
    }
  });

  it('returns failure with attempts log when every provider fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'auth' } }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'down' } }, { status: 503 }));
    const res = await runChatChain(
      [provider({ id: 'gemini' }), provider({ id: 'groq' })],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toHaveLength(2);
      expect(res.attempts[0].provider).toBe('gemini');
      expect(res.attempts[0].status).toBe(401);
      expect(res.attempts[1].provider).toBe('groq');
      expect(res.attempts[1].status).toBe(503);
    }
  });

  it('skips a provider that returns an empty string', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(okBody('')))
      .mockResolvedValueOnce(jsonResponse(okBody('from groq')));
    const res = await runChatChain(
      [provider({ id: 'gemini' }), provider({ id: 'groq' })],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.provider).toBe('groq');
      expect(res.text).toBe('from groq');
    }
  });

  it('estimates USD cost from reported tokens for paid providers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody('answer', 2000, 250)));
    const res = await runChatChain(
      [
        provider({
          id: 'openai',
          inputPriceUsdPerM: 0.15, // gpt-4o-mini default
          outputPriceUsdPerM: 0.6,
        }),
      ],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 2000/M * 0.15 + 250/M * 0.6 = 0.0003 + 0.00015 = 0.00045
      expect(res.costUsd).toBeCloseTo(0.00045, 6);
    }
  });

  it('includes the bearer token only in the auth header (never in URL)', async () => {
    const fetchImpl = vi.fn().mockImplementation((url, init) => {
      expect(url).toBe('https://example.com/v1/chat/completions');
      // Make sure the API key never appears in the URL
      expect(String(url)).not.toContain('secret-key');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe('Bearer secret-key');
      return Promise.resolve(jsonResponse(okBody('ok')));
    });
    await runChatChain(
      [provider({ apiKey: 'secret-key' })],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
  });

  it('OpenAI-compat success returns empty citations + searchQueries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody('hi back')));
    const res = await runChatChain(
      [provider({ id: 'groq' })],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.citations).toEqual([]);
      expect(res.searchQueries).toEqual([]);
    }
  });
});

describe('aibot llm: gemini grounded path', () => {
  function geminiProvider(useGrounding = true): LlmProviderConfig {
    return {
      id: 'gemini',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash',
      inputPriceUsdPerM: 0,
      outputPriceUsdPerM: 0,
      extras: {
        useGrounding,
        nativeBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      },
    };
  }

  function geminiOk(text: string, citations: Array<{ uri: string; title: string }> = [], queries: string[] = []): Response {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text }], role: 'model' },
            groundingMetadata: {
              groundingChunks: citations.map((c) => ({ web: c })),
              webSearchQueries: queries,
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        modelVersion: 'gemini-2.5-flash-actual',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('routes to native generateContent endpoint with google_search tool when grounding is on', async () => {
    const fetchImpl = vi.fn().mockImplementation((url, init) => {
      const u = String(url);
      expect(u).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
      expect(u).toContain('key=gemini-key');
      const body = JSON.parse(String(init?.body ?? '{}'));
      expect(body.tools).toEqual([{ google_search: {} }]);
      // System instruction should be lifted out of contents.
      expect(body.systemInstruction?.parts?.[0]?.text).toContain('You are EticaBot');
      // Only user/model turns belong in contents.
      expect(body.contents).toHaveLength(1);
      expect(body.contents[0].role).toBe('user');
      return Promise.resolve(geminiOk('answer'));
    });
    const res = await runChatChain(
      [geminiProvider(true)],
      {
        messages: [
          { role: 'system', content: 'You are EticaBot.' },
          { role: 'user', content: 'what was the most recent NHL game?' },
        ],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not include the API key in the request body', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url, init) => {
      const body = String(init?.body ?? '');
      expect(body).not.toContain('gemini-key');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // Native API uses the URL-key auth scheme, not bearer.
      expect(headers.authorization).toBeUndefined();
      return Promise.resolve(geminiOk('ok'));
    });
    await runChatChain(
      [geminiProvider(true)],
      { messages: [{ role: 'user', content: 'q' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
  });

  it('extracts citations from groundingChunks (deduped, in order)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiOk(
        'The Bruins beat the Habs 4-2 last night.',
        [
          { uri: 'https://nhl.com/x', title: 'NHL.com — Bruins vs Habs' },
          { uri: 'https://espn.com/y', title: 'ESPN' },
          // Duplicate URL with different title — should be dropped.
          { uri: 'https://nhl.com/x', title: 'duplicate' },
        ],
        ['Bruins Habs result'],
      ),
    );
    const res = await runChatChain(
      [geminiProvider(true)],
      { messages: [{ role: 'user', content: 'most recent NHL game?' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.citations).toEqual([
        { url: 'https://nhl.com/x', title: 'NHL.com — Bruins vs Habs' },
        { url: 'https://espn.com/y', title: 'ESPN' },
      ]);
      expect(res.searchQueries).toEqual(['Bruins Habs result']);
    }
  });

  it('returns empty citations when the model did not search', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(geminiOk('answer with no grounding'));
    const res = await runChatChain(
      [geminiProvider(true)],
      { messages: [{ role: 'user', content: 'what is 2+2' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.citations).toEqual([]);
      expect(res.searchQueries).toEqual([]);
      expect(res.text).toBe('answer with no grounding');
    }
  });

  it('grounding=false stays on the OpenAI-compat path', async () => {
    const fetchImpl = vi.fn().mockImplementation((url) => {
      // Should hit the OpenAI-compat surface, NOT the native one.
      expect(String(url)).toContain('/openai/chat/completions');
      expect(String(url)).not.toContain(':generateContent');
      return Promise.resolve(jsonResponse(okBody('plain text')));
    });
    const res = await runChatChain(
      [geminiProvider(false)],
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.citations).toEqual([]);
    }
  });

  it('falls back to the next provider when grounded gemini errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'quota' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(okBody('from groq')));
    const res = await runChatChain(
      [
        geminiProvider(true),
        {
          id: 'groq',
          apiKey: 'k',
          baseUrl: 'https://api.groq.com/openai/v1',
          model: 'llama',
          inputPriceUsdPerM: 0,
          outputPriceUsdPerM: 0,
        },
      ],
      { messages: [{ role: 'user', content: 'q' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.provider).toBe('groq');
      expect(res.citations).toEqual([]);
    }
  });
});
