/**
 * Resilient Groq chat-completions client.
 *
 * Goals (user requirement: "groq should also never fail"):
 *   1. Multi-key rotation. `GROQ_API_KEYS` is read as a comma-separated
 *      list and we cycle keys per call. Falls back to the single-key
 *      envs (`AIBOT_LLM_GROQ_API_KEY`, `GROQ_API_KEY`). When a key
 *      returns 401/403/429-daily we skip it for the rest of the call.
 *   2. Per-attempt retry with exponential backoff on 429/5xx and
 *      transient network errors. Backoff is bounded by the caller's
 *      AbortSignal so we never run past the request budget.
 *   3. Model cascade. Each attempt can pick a different model; default
 *      cascade is 70B-versatile → 8B-instant (much higher daily cap).
 *   4. Per-call timeout enforced even when callers forget to pass a
 *      signal — we still honour the caller's signal if present.
 *
 * The helper is pure (no Redis, no global state) so it's safe in any
 * route or worker context. Caller decides whether to retry the whole
 * call by re-invoking `groqChat` later (e.g. from a persistent queue).
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Default order: 70B first (best JSON adherence), 8B fallback (much
 * higher daily cap so we don't get rate-limited at scale). */
export const GROQ_MODEL_PRIMARY = 'llama-3.3-70b-versatile';
export const GROQ_MODEL_FALLBACK = 'llama-3.1-8b-instant';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqChatRequest {
  messages: GroqMessage[];
  /** Cascade of models to try in order. Defaults to [70B, 8B]. */
  models?: string[];
  temperature?: number;
  max_tokens?: number;
  /** If true, request strict JSON output (only on attempts that can
   *  tolerate Groq's `json_validate_failed` 400s — we drop this flag
   *  automatically on the second attempt of each model). */
  jsonMode?: boolean;
  /** Hard ceiling for the whole call (ms). Default 22s. */
  timeoutMs?: number;
  /** Caller's own abort signal. We compose it with our internal one. */
  signal?: AbortSignal;
  /** Per-key+model retry count for transient failures. Default 3. */
  maxRetriesPerKey?: number;
}

export interface GroqChatResult {
  content: string;
  model: string;
  /** Which key index in the pool produced the result. */
  keyIndex: number;
  /** Total attempts consumed across all keys/models. */
  attempts: number;
}

export class GroqError extends Error {
  status: number;
  detail?: string;
  attempts: number;

  constructor(message: string, opts: { status?: number; detail?: string; attempts: number }) {
    super(message);
    this.name = 'GroqError';
    this.status = opts.status ?? 0;
    this.detail = opts.detail;
    this.attempts = opts.attempts;
  }
}

/* ------------------------------------------------------------------ */
/*  Key pool                                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve the Groq key pool. We accept either a comma-separated list
 * (`GROQ_API_KEYS=key1,key2,key3`) for rotation or the single-key envs
 * for backwards compatibility.
 */
export function readGroqKeyPool(): string[] {
  const pool = new Set<string>();
  const multi = process.env.GROQ_API_KEYS ?? process.env.AIBOT_LLM_GROQ_API_KEYS;
  if (multi) {
    for (const piece of multi.split(',')) {
      const k = piece.trim();
      if (k) pool.add(k);
    }
  }
  const single =
    process.env.AIBOT_LLM_GROQ_API_KEY ?? process.env.GROQ_API_KEY ?? '';
  if (single) pool.add(single.trim());
  return [...pool];
}

export function hasGroqKey(): boolean {
  return readGroqKeyPool().length > 0;
}

/* ------------------------------------------------------------------ */
/*  Retry helpers                                                      */
/* ------------------------------------------------------------------ */

const BACKOFF_BASE_MS = 350;

function backoffMs(attempt: number): number {
  // 350ms, 700ms, 1.4s, 2.8s, capped at ~3s. Cheap when fast-recovering;
  // long enough to ride out Groq's per-minute rate-limit bursts.
  return Math.min(3000, BACKOFF_BASE_MS * 2 ** attempt);
}

function isRetryableStatus(status: number): boolean {
  // 429 (rate), 408 (timeout), 5xx (server). We do NOT retry 4xx other
  // than 408/429 — those are caller errors and won't change with retry.
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/** 401/403 means this key is dead — skip it for the rest of the call. */
function isFatalKeyStatus(status: number): boolean {
  return status === 401 || status === 403;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Core                                                               */
/* ------------------------------------------------------------------ */

/**
 * Compose an abort signal that aborts when either the caller's signal
 * or the internal timeout fires.
 */
function composeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let cleared = false;
  const onExternalAbort = () => {
    if (!cleared) ctrl.abort();
  };
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    clear: () => {
      cleared = true;
      clearTimeout(t);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * One HTTP call to Groq. Returns the assistant content on success, or
 * a structured failure indicator otherwise. Never throws unless the
 * fetch itself rejects (handled by caller).
 */
async function callOnce(
  apiKey: string,
  model: string,
  req: GroqChatRequest,
  useJsonMode: boolean,
  signal: AbortSignal,
): Promise<
  | { ok: true; content: string }
  | { ok: false; status: number; detail: string; fatalKey: boolean }
> {
  const body: Record<string, unknown> = {
    model,
    temperature: req.temperature ?? 0.4,
    max_tokens: req.max_tokens ?? 800,
    messages: req.messages,
  };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      detail: detail.slice(0, 400),
      fatalKey: isFatalKeyStatus(res.status),
    };
  }

  const payload = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
  return { ok: true, content };
}

/**
 * Resilient Groq chat completion.
 *
 * Tries every (key × model) pair, with per-pair retries on transient
 * errors. Drops keys that 401/403 mid-call. On success returns the
 * first non-empty content. Throws {@link GroqError} only when every
 * attempt has been exhausted.
 */
export async function groqChat(req: GroqChatRequest): Promise<GroqChatResult> {
  const keys = readGroqKeyPool();
  if (keys.length === 0) {
    throw new GroqError('No Groq API key configured.', { attempts: 0 });
  }

  const models =
    req.models && req.models.length > 0
      ? req.models
      : [GROQ_MODEL_PRIMARY, GROQ_MODEL_FALLBACK];
  const timeoutMs = req.timeoutMs ?? 22_000;
  const maxRetries = Math.max(1, req.maxRetriesPerKey ?? 3);

  const composed = composeSignal(req.signal, timeoutMs);
  const liveKeys = new Set<number>(keys.map((_, i) => i));

  let attempts = 0;
  let lastStatus = 0;
  let lastDetail = '';

  try {
    for (const model of models) {
      // First pass with jsonMode (if requested); second pass without —
      // Groq sometimes returns 400 `json_validate_failed` even on valid
      // JSON because of its strict server-side validator.
      const jsonPasses = req.jsonMode ? [true, false] : [false];

      for (const useJsonMode of jsonPasses) {
        for (const keyIndex of [...liveKeys]) {
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            attempts++;

            try {
              const r = await callOnce(
                keys[keyIndex] ?? '',
                model,
                req,
                useJsonMode,
                composed.signal,
              );
              if (r.ok) {
                if (r.content) {
                  return { content: r.content, model, keyIndex, attempts };
                }
                // Empty content is treated as transient (Groq sometimes
                // returns an empty assistant message when overloaded).
                lastStatus = 200;
                lastDetail = 'empty content';
              } else {
                lastStatus = r.status;
                lastDetail = r.detail;
                if (r.fatalKey) {
                  liveKeys.delete(keyIndex);
                  break;
                }
                if (!isRetryableStatus(r.status)) {
                  // Non-retryable on this key+model+mode (e.g. 400
                  // bad-request). Move on to the next mode/model.
                  break;
                }
              }
            } catch (err) {
              // Network/abort. If the call was aborted by our timeout,
              // surface it so the caller fails fast.
              if (composed.signal.aborted) {
                throw new GroqError('Groq request timed out.', {
                  status: 408,
                  detail: lastDetail,
                  attempts,
                });
              }
              lastStatus = 0;
              lastDetail = err instanceof Error ? err.message : String(err);
            }

            // Don't sleep after the final retry of this loop.
            if (attempt < maxRetries - 1) {
              await sleep(backoffMs(attempt), composed.signal);
              if (composed.signal.aborted) {
                throw new GroqError('Groq request timed out.', {
                  status: 408,
                  detail: lastDetail,
                  attempts,
                });
              }
            }
          }
        }

        if (liveKeys.size === 0) break;
      }

      if (liveKeys.size === 0) break;
    }
  } finally {
    composed.clear();
  }

  throw new GroqError(`Groq exhausted all keys and retries (${lastStatus}).`, {
    status: lastStatus,
    detail: lastDetail,
    attempts,
  });
}
