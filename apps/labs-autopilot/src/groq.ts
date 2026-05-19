/**
 * Resilient Groq chat client for the labs-autopilot worker.
 *
 * Mirrors `apps/web/src/lib/labs/groq.ts` but is self-contained because
 * the worker package can't reach into the Next.js app's lib tree at
 * build time. Keep the two in sync.
 *
 * Goals:
 *   - Multi-key rotation via `GROQ_API_KEYS` (comma-separated).
 *   - Per-attempt retry with exponential backoff on 429/5xx.
 *   - Model cascade (default: 70B → 8B).
 *   - Optional strict JSON mode that auto-drops on retry when Groq's
 *     server-side validator rejects otherwise-valid output.
 *   - All retries bounded by a single global timeout.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export const GROQ_MODEL_PRIMARY = 'llama-3.3-70b-versatile';
export const GROQ_MODEL_FALLBACK = 'llama-3.1-8b-instant';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqChatRequest {
  messages: GroqMessage[];
  models?: string[];
  temperature?: number;
  max_tokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRetriesPerKey?: number;
}

export interface GroqChatResult {
  content: string;
  model: string;
  keyIndex: number;
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

export function readGroqKeyPool(): string[] {
  const pool = new Set<string>();
  const multi = process.env.GROQ_API_KEYS;
  if (multi) {
    for (const piece of multi.split(',')) {
      const k = piece.trim();
      if (k) pool.add(k);
    }
  }
  const single = process.env.GROQ_API_KEY ?? '';
  if (single) pool.add(single.trim());
  return [...pool];
}

const BACKOFF_BASE_MS = 350;
function backoffMs(attempt: number): number {
  return Math.min(3000, BACKOFF_BASE_MS * 2 ** attempt);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}
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

function composeSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let cleared = false;
  const onExternal = () => {
    if (!cleared) ctrl.abort();
  };
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onExternal, { once: true });
  }
  return {
    signal: ctrl.signal,
    clear: () => {
      cleared = true;
      clearTimeout(t);
      if (external) external.removeEventListener('abort', onExternal);
    },
  };
}

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

export async function groqChat(req: GroqChatRequest): Promise<GroqChatResult> {
  const keys = readGroqKeyPool();
  if (keys.length === 0) {
    throw new GroqError('No Groq API key configured.', { attempts: 0 });
  }
  const models =
    req.models && req.models.length > 0 ? req.models : [GROQ_MODEL_PRIMARY, GROQ_MODEL_FALLBACK];
  const timeoutMs = req.timeoutMs ?? 45_000;
  const maxRetries = Math.max(1, req.maxRetriesPerKey ?? 3);
  const composed = composeSignal(req.signal, timeoutMs);
  const liveKeys = new Set<number>(keys.map((_, i) => i));

  let attempts = 0;
  let lastStatus = 0;
  let lastDetail = '';

  try {
    for (const model of models) {
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
                lastStatus = 200;
                lastDetail = 'empty content';
              } else {
                lastStatus = r.status;
                lastDetail = r.detail;
                if (r.fatalKey) {
                  liveKeys.delete(keyIndex);
                  break;
                }
                if (!isRetryableStatus(r.status)) break;
              }
            } catch (err) {
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
