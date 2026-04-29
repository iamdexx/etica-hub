/**
 * LLM client for the Etica AI Telegram bot.
 *
 * All providers we support (Gemini, Groq, OpenAI, Mistral, OpenRouter)
 * expose an OpenAI-compatible `chat/completions` endpoint. We talk to
 * each one with the same minimal `fetch`-based client and run them as a
 * failover chain — primary first, fallbacks behind it. The first
 * provider that returns a non-error response wins; subsequent providers
 * are skipped.
 *
 * Why a chain instead of a single provider:
 *   - Both Gemini and Groq run truly-free tiers with daily request
 *     ceilings. With a chain, the chat is unaffected when one provider
 *     rate-limits us.
 *   - Operators can append a paid provider (e.g. OpenAI) at the end of
 *     the chain and never pay a cent unless every free tier is
 *     simultaneously degraded.
 *   - Adding a new provider is one env var; no code change.
 */

import type { LlmProviderConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /**
   * Hard ceiling on output tokens. Defaults to 2048 — large enough for
   * long-form answers (system explanations, code snippets, brainstorming
   * lists) without burning quota on runaway generations. The Telegram
   * sender chunks anything past 4096 chars across multiple messages, so
   * the model is free to use the full budget.
   */
  maxOutputTokens?: number;
  /** Sampling temperature, 0..2. Defaults to 0.4 (mostly factual). */
  temperature?: number;
}

export interface ChatSuccess {
  ok: true;
  /** The provider that produced this response. */
  provider: string;
  /** Model id reported back by the provider (may differ from request). */
  model: string;
  /** The full assistant message. */
  text: string;
  /** Best-effort token usage breakdown; falsy if the provider didn't report. */
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  /** Estimated USD cost for this single call. */
  costUsd: number;
  /**
   * Sources the model cited via Google Search grounding. Empty when the
   * call wasn't grounded or the model didn't search. Each entry is a
   * resolvable URL paired with a human-readable title (typically the
   * page's `<title>`); deduplicated and ordered as the model returned
   * them.
   */
  citations: ChatCitation[];
  /**
   * Search queries the model issued to Google. Empty when the model
   * didn't search. Useful for transparency / log inspection.
   */
  searchQueries: string[];
}

export interface ChatCitation {
  url: string;
  title: string;
}

export interface ChatFailure {
  ok: false;
  /** Last provider that was attempted. */
  provider: string | null;
  /** Concise human-readable reason. */
  reason: string;
  /** Per-provider attempt log, oldest to newest. */
  attempts: ChatAttemptLog[];
}

export interface ChatAttemptLog {
  provider: string;
  status: number | null;
  error: string | null;
}

export type ChatResult = ChatSuccess | ChatFailure;

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

const DEFAULT_TIMEOUT_MS = 25_000;

function estimateCostUsd(
  provider: LlmProviderConfig,
  inputTokens: number | null,
  outputTokens: number | null,
): number {
  if (provider.inputPriceUsdPerM === 0 && provider.outputPriceUsdPerM === 0) {
    return 0;
  }
  const inUsd = ((inputTokens ?? 0) / 1_000_000) * provider.inputPriceUsdPerM;
  const outUsd = ((outputTokens ?? 0) / 1_000_000) * provider.outputPriceUsdPerM;
  return inUsd + outUsd;
}

async function callProvider(
  provider: LlmProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ res: ChatSuccess | null; status: number | null; error: string | null }> {
  const url = `${provider.baseUrl}/chat/completions`;
  const body = {
    model: provider.model,
    messages: request.messages,
    max_tokens: request.maxOutputTokens ?? 2048,
    temperature: request.temperature ?? 0.4,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      res: null,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as OpenAiChatResponse;
      detail = data.error?.message ?? '';
    } catch {
      // ignore body-parse failures; status alone is enough
    }
    return {
      res: null,
      status: res.status,
      error: detail.length > 0 ? detail : `http ${res.status}`,
    };
  }

  let json: OpenAiChatResponse;
  try {
    json = (await res.json()) as OpenAiChatResponse;
  } catch (err) {
    return {
      res: null,
      status: res.status,
      error: `malformed json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = json.choices?.[0]?.message?.content ?? '';
  if (typeof text !== 'string' || text.length === 0) {
    return {
      res: null,
      status: res.status,
      error: 'empty response',
    };
  }

  const inputTokens = typeof json.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : null;
  const outputTokens = typeof json.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : null;

  return {
    res: {
      ok: true,
      provider: provider.id,
      model: json.model ?? provider.model,
      text: text.trim(),
      usage: { inputTokens, outputTokens },
      costUsd: estimateCostUsd(provider, inputTokens, outputTokens),
      citations: [],
      searchQueries: [],
    },
    status: res.status,
    error: null,
  };
}

interface GeminiNativeResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  error?: { message?: string; code?: number };
}

/**
 * Call Gemini's native `generateContent` endpoint with the built-in
 * `google_search` tool enabled. Required because the OpenAI-compat
 * surface (`/v1beta/openai/chat/completions`) does NOT expose Gemini's
 * built-in tools — only this native path returns grounding metadata.
 *
 * The model decides per-request whether to actually search; questions
 * the Live Context already answers (TVL, harvest counts, etc.) won't
 * trigger a search.
 */
async function callGeminiGrounded(
  provider: LlmProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ res: ChatSuccess | null; status: number | null; error: string | null }> {
  const extras = provider.extras;
  if (!extras) {
    return { res: null, status: null, error: 'gemini extras missing' };
  }
  const url =
    `${extras.nativeBaseUrl}/models/${encodeURIComponent(provider.model)}:generateContent` +
    `?key=${encodeURIComponent(provider.apiKey)}`;

  // Native Gemini distinguishes systemInstruction from contents. Map the
  // OpenAI-shape `system` role onto systemInstruction (concatenated when
  // there are multiple); user / assistant turns become user / model
  // turns under contents.
  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const m of request.messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }

  const body: Record<string, unknown> = {
    contents,
    tools: [{ google_search: {} }],
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens ?? 2048,
      temperature: request.temperature ?? 0.4,
    },
  };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      res: null,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as GeminiNativeResponse;
      detail = data.error?.message ?? '';
    } catch {
      // ignore body-parse failures
    }
    return {
      res: null,
      status: res.status,
      error: detail.length > 0 ? detail : `http ${res.status}`,
    };
  }

  let json: GeminiNativeResponse;
  try {
    json = (await res.json()) as GeminiNativeResponse;
  } catch (err) {
    return {
      res: null,
      status: res.status,
      error: `malformed json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (text.length === 0) {
    return { res: null, status: res.status, error: 'empty response' };
  }

  const inputTokens =
    typeof json.usageMetadata?.promptTokenCount === 'number'
      ? json.usageMetadata.promptTokenCount
      : null;
  const outputTokens =
    typeof json.usageMetadata?.candidatesTokenCount === 'number'
      ? json.usageMetadata.candidatesTokenCount
      : null;

  const citations: ChatCitation[] = [];
  const seenUrls = new Set<string>();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri?.trim() ?? '';
    if (url.length === 0 || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const title = chunk.web?.title?.trim() ?? url;
    citations.push({ url, title });
  }
  const searchQueries = (candidate?.groundingMetadata?.webSearchQueries ?? [])
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  return {
    res: {
      ok: true,
      provider: provider.id,
      model: json.modelVersion ?? provider.model,
      text,
      usage: { inputTokens, outputTokens },
      costUsd: estimateCostUsd(provider, inputTokens, outputTokens),
      citations,
      searchQueries,
    },
    status: res.status,
    error: null,
  };
}

/**
 * Dispatcher: routes to the grounded Gemini path when the provider is
 * Gemini AND grounding is enabled in extras; otherwise uses the
 * OpenAI-compat path. Provider-agnostic from the caller's perspective.
 */
async function dispatchProvider(
  provider: LlmProviderConfig,
  request: ChatRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ res: ChatSuccess | null; status: number | null; error: string | null }> {
  if (provider.id === 'gemini' && provider.extras?.useGrounding) {
    return callGeminiGrounded(provider, request, fetchImpl, timeoutMs);
  }
  return callProvider(provider, request, fetchImpl, timeoutMs);
}

export interface ChatChainOptions {
  fetchImpl?: typeof fetch;
  /** Per-provider request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Run the provider chain. Returns the first successful response, or a
 * `ChatFailure` listing every attempt if every provider failed.
 */
export async function runChatChain(
  providers: LlmProviderConfig[],
  request: ChatRequest,
  opts: ChatChainOptions = {},
): Promise<ChatResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const attempts: ChatAttemptLog[] = [];
  let lastProvider: string | null = null;

  for (const provider of providers) {
    lastProvider = provider.id;
    const { res, status, error } = await dispatchProvider(provider, request, fetchImpl, timeoutMs);
    attempts.push({ provider: provider.id, status, error });
    if (res) return res;
  }

  return {
    ok: false,
    provider: lastProvider,
    reason: providers.length === 0 ? 'no providers configured' : 'all providers failed',
    attempts,
  };
}
