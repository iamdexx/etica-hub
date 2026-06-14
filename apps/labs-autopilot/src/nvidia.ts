/**
 * Nvidia LLM client for the labs-autopilot worker.
 *
 * All LLM calls are proxied through the Vercel `/api/labs/llm` endpoint
 * because Nvidia's API is unreachable from GitHub Actions runners.
 *
 * Uses only Nemotron 3 Ultra 550B as the sole reasoning model.
 *
 * Rate limiting: enforces 1.5s minimum gap between calls (40 RPM max).
 * Env: LABS_AUTOPILOT_BASE_URL, LABS_AUTOPILOT_TOKEN
 */

export const NVIDIA_MODEL_PRIMARY = 'nvidia/nemotron-3-ultra-550b-a55b';
export const NVIDIA_MODEL_FALLBACK = 'nvidia/nemotron-3-ultra-550b-a55b';

export interface NvidiaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NvidiaChatRequest {
  messages: NvidiaMessage[];
  models?: string[];
  temperature?: number;
  max_tokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRetriesPerKey?: number;
}

export interface NvidiaChatResult {
  content: string;
  model: string;
  keyIndex: number;
  attempts: number;
}

export class NvidiaLLMError extends Error {
  status: number;
  detail?: string;
  attempts: number;
  constructor(message: string, opts: { status?: number; detail?: string; attempts: number }) {
    super(message);
    this.name = 'NvidiaLLMError';
    this.status = opts.status ?? 0;
    this.detail = opts.detail;
    this.attempts = opts.attempts;
  }
}

/** Read the Nvidia key pool — kept for compatibility with fold.ts which calls Nvidia directly. */
export function readNvidiaLLMKeyPool(): string[] {
  const pool = new Set<string>();
  const multi = process.env.NVIDIA_API_KEYS;
  if (multi) {
    for (const piece of multi.split(',')) {
      const k = piece.trim();
      if (k) pool.add(k);
    }
  }
  const single = process.env.NVIDIA_API_KEY ?? '';
  if (single) pool.add(single.trim());
  return [...pool];
}

// ─── Rate limiting ───
// Nvidia LLM (integrate.api.nvidia.com) is capped at 40 RPM. A 1.6s gap
// holds us at ~37.5 RPM, leaving headroom so timing jitter can't push us
// over the limit. The worker runs as a single process (the workflow's
// concurrency group prevents overlapping ticks), so this module-level
// pacing globally bounds the LLM request rate.
const MIN_INTERVAL_MS = 1600;

// Serialize the gate through a promise chain so that even concurrent
// callers (e.g. Promise.all of several LLM calls) are spaced apart and
// can never burst past the limit by all reading the timestamp at once.
let gate: Promise<void> = Promise.resolve();

function enforceRateLimit(): Promise<void> {
  const prev = gate;
  gate = (async () => {
    await prev;
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
  })();
  return prev;
}

// ─── Proxy-based nvidiaChat ───

const BASE_URL = (process.env.LABS_AUTOPILOT_BASE_URL ?? 'https://eticahub.com').replace(/\/$/, '');
const TOKEN = process.env.LABS_AUTOPILOT_TOKEN || '';

export async function nvidiaChat(req: NvidiaChatRequest): Promise<NvidiaChatResult> {
  if (!TOKEN) {
    throw new NvidiaLLMError('LABS_AUTOPILOT_TOKEN not set — cannot proxy LLM calls.', { attempts: 0 });
  }

  const model = req.models && req.models.length > 0 ? req.models[0]! : NVIDIA_MODEL_PRIMARY;
  const maxRetries = Math.max(1, req.maxRetriesPerKey ?? 3);

  let lastError = '';
  let attempts = 0;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await enforceRateLimit();
    attempts++;

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 55_000);

      // Combine external signal
      if (req.signal) {
        if (req.signal.aborted) { clearTimeout(timeout); ctrl.abort(); }
        else req.signal.addEventListener('abort', () => { clearTimeout(timeout); ctrl.abort(); }, { once: true });
      }

      const res = await fetch(`${BASE_URL}/api/labs/llm`, {
        method: 'POST',
        headers: {
          'x-labs-worker-token': TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: req.messages,
          model,
          temperature: req.temperature ?? 0.4,
          max_tokens: req.max_tokens ?? 800,
          jsonMode: req.jsonMode ?? false,
          timeoutMs: Math.min(req.timeoutMs ?? 55_000, 55_000),
        }),
        signal: ctrl.signal,
      });

      clearTimeout(timeout);

      const data = (await res.json()) as {
        ok: boolean;
        content?: string;
        model?: string;
        attempts?: number;
        error?: string;
        status?: number;
      };

      if (data.ok && data.content) {
        return {
          content: data.content,
          model: data.model || model,
          keyIndex: 0,
          attempts,
        };
      }

      lastError = data.error || `HTTP ${res.status}`;

      // Don't retry non-retryable errors
      if (res.status === 400 || res.status === 401) break;

      // Retry on 429, 5xx, or proxy errors
      if (attempt < maxRetries - 1) {
        const backoff = Math.min(15_000, 2000 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, backoff));
      }
    } catch (err) {
      if (req.signal?.aborted) {
        throw new NvidiaLLMError('Request aborted by caller.', { status: 408, attempts });
      }
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries - 1) {
        const backoff = Math.min(15_000, 2000 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw new NvidiaLLMError(`Nvidia LLM proxy failed: ${lastError}`, {
    status: 502,
    detail: lastError,
    attempts,
  });
}
