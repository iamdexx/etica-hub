/**
 * Nvidia NIM LLM client for EticaHub web API routes.
 *
 * Nvidia NIM LLM client — uses Nvidia Nemotron 3 Ultra 550B
 * via the OpenAI-compatible NIM endpoint. Single key, retry + backoff.
 *
 * Env: NVIDIA_API_KEY (shared with ESMFold).
 */

const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

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

export class NvidiaError extends Error {
  status: number;
  detail?: string;
  attempts: number;
  constructor(message: string, opts: { status?: number; detail?: string; attempts: number }) {
    super(message);
    this.name = 'NvidiaError';
    this.status = opts.status ?? 0;
    this.detail = opts.detail;
    this.attempts = opts.attempts;
  }
}

export function hasNvidiaKey(): boolean {
  return readNvidiaKeyPool().length > 0;
}

export function readNvidiaKeyPool(): string[] {
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

const BACKOFF_BASE_MS = 2000;
function backoffMs(attempt: number): number {
  return Math.min(15_000, BACKOFF_BASE_MS * 2 ** attempt);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); resolve(); };
      if (signal.aborted) { clearTimeout(t); resolve(); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function composeSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let cleared = false;
  const onExternal = () => { if (!cleared) ctrl.abort(); };
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onExternal, { once: true });
  }
  return {
    signal: ctrl.signal,
    clear: () => { cleared = true; clearTimeout(t); if (external) external.removeEventListener('abort', onExternal); },
  };
}

async function callOnce(
  apiKey: string,
  model: string,
  req: NvidiaChatRequest,
  useJsonMode: boolean,
  signal: AbortSignal,
): Promise<{ ok: true; content: string } | { ok: false; status: number; detail: string }> {
  const body: Record<string, unknown> = {
    model,
    temperature: req.temperature ?? 0.4,
    max_tokens: req.max_tokens ?? 800,
    messages: req.messages,
  };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(NVIDIA_CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: detail.slice(0, 400) };
  }
  const payload = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
  return { ok: true, content };
}

export async function nvidiaChat(req: NvidiaChatRequest): Promise<NvidiaChatResult> {
  const keys = readNvidiaKeyPool();
  if (keys.length === 0) {
    throw new NvidiaError('No Nvidia API key configured (NVIDIA_API_KEY).', { attempts: 0 });
  }
  const model = req.models && req.models.length > 0 ? req.models[0]! : NVIDIA_MODEL_PRIMARY;
  const timeoutMs = req.timeoutMs ?? 22_000;
  const maxRetries = Math.max(1, req.maxRetriesPerKey ?? 4);
  const composed = composeSignal(req.signal, timeoutMs);
  const apiKey = keys[0]!;

  let attempts = 0;
  let lastStatus = 0;
  let lastDetail = '';

  try {
    const jsonPasses = req.jsonMode ? [true, false] : [false];
    for (const useJsonMode of jsonPasses) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        attempts++;
        try {
          const r = await callOnce(apiKey, model, req, useJsonMode, composed.signal);
          if (r.ok) {
            if (r.content) return { content: r.content, model, keyIndex: 0, attempts };
            lastStatus = 200;
            lastDetail = 'empty content';
          } else {
            lastStatus = r.status;
            lastDetail = r.detail;
            if (!isRetryableStatus(r.status)) break;
          }
        } catch (err) {
          if (composed.signal.aborted) {
            throw new NvidiaError('Nvidia LLM request timed out.', { status: 408, detail: lastDetail, attempts });
          }
          lastStatus = 0;
          lastDetail = err instanceof Error ? err.message : String(err);
        }
        if (attempt < maxRetries - 1) {
          await sleep(backoffMs(attempt), composed.signal);
          if (composed.signal.aborted) {
            throw new NvidiaError('Nvidia LLM request timed out.', { status: 408, detail: lastDetail, attempts });
          }
        }
      }
    }
  } finally {
    composed.clear();
  }

  throw new NvidiaError(`Nvidia LLM exhausted retries (${lastStatus}).`, { status: lastStatus, detail: lastDetail, attempts });
}
