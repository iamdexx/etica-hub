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
    },
    status: res.status,
    error: null,
  };
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
    const { res, status, error } = await callProvider(provider, request, fetchImpl, timeoutMs);
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
