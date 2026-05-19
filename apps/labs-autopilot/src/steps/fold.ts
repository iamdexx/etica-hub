/**
 * Worker-side folding cascade. Mirrors apps/web/src/lib/labs/engines/* but
 * stays a thin local copy so the autopilot binary stays independent of the
 * Next.js bundle.
 *
 * Order:
 *   1. NVIDIA NIM ESMFold (free, most reliable host today)
 *   2. Hugging Face Router ESMFold (fallback; intermittent)
 *
 * Each engine gets up to 3 attempts with exponential backoff (0s, 5s,
 * 30s) and a 90s per-attempt timeout. The cascade exits on the first
 * successful PDB. If every engine exhausts retries, the caller decides
 * whether to publish the candidate with a sequence-only score
 * (`structurePending: true`) or surface an error.
 */

const NVIDIA_INVOKE_URL = 'https://health.api.nvidia.com/v1/biology/nvidia/esmfold';
const NVIDIA_STATUS_URL = 'https://health.api.nvidia.com/v1/status';
const HF_URL = 'https://router.huggingface.co/hf-inference/models/facebook/esmfold_v1';

const POLL_INTERVAL_MS = 1_500;
const POLL_BUDGET_MS = Number(process.env.LABS_AUTOPILOT_FOLD_TIMEOUT_MS ?? '60000');

const PER_ENGINE_MAX_ATTEMPTS = 3;
const PER_ATTEMPT_TIMEOUT_MS = 90_000;
const BACKOFF_SCHEDULE_MS: readonly number[] = [0, 5_000, 30_000];

export type FoldResult = { ok: true; pdb: string } | { ok: false; error: string };

export type CascadeAttempt = {
  engine: 'nvidia-esmfold' | 'hf-esmfold';
  ok: boolean;
  error?: string;
  durationMs: number;
  attempts: number;
};

export type CascadeOutcome =
  | { ok: true; engine: 'nvidia-esmfold' | 'hf-esmfold'; pdb: string; attempts: CascadeAttempt[] }
  | { ok: false; error: string; attempts: CascadeAttempt[] };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractPdb(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.pdbs) && typeof record.pdbs[0] === 'string') return record.pdbs[0];
  if (typeof record.pdb === 'string') return record.pdb;
  if (typeof record.output === 'string') return record.output;
  return null;
}

function looksLikePdb(text: string): boolean {
  return /^(HEADER|ATOM|MODEL|REMARK|HETATM)/m.test(text.slice(0, 200));
}

function isPermanentFailure(error: string): boolean {
  return (
    /not set$/i.test(error) ||
    /not configured/i.test(error) ||
    /not currently serving/i.test(error) ||
    /not (supported|deployed)/i.test(error)
  );
}

async function callWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** NVIDIA NIM ESMFold (free, async 202 polling). */
export async function foldWithNvidia(sequence: string): Promise<FoldResult> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return { ok: false, error: 'NVIDIA_API_KEY not set' };

  let response: Response;
  try {
    response = await fetch(NVIDIA_INVOKE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ sequence }),
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }

  if (response.status === 200) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: 'NVIDIA returned non-JSON 200' };
    }
    const pdb = extractPdb(payload);
    if (pdb && looksLikePdb(pdb)) return { ok: true, pdb };
    return { ok: false, error: 'NVIDIA 200 payload missing PDB' };
  }

  if (response.status === 202) {
    const reqId = response.headers.get('nvcf-reqid') ?? response.headers.get('NVCF-REQID');
    if (!reqId) return { ok: false, error: 'NVIDIA 202 missing nvcf-reqid' };

    const deadline = Date.now() + POLL_BUDGET_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      let poll: Response;
      try {
        poll = await fetch(`${NVIDIA_STATUS_URL}/${reqId}`, {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          cache: 'no-store',
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'poll error' };
      }
      if (poll.status === 202) continue;
      if (poll.status === 200) {
        let payload: unknown;
        try {
          payload = await poll.json();
        } catch {
          return { ok: false, error: 'NVIDIA poll returned non-JSON 200' };
        }
        const pdb = extractPdb(payload);
        if (pdb && looksLikePdb(pdb)) return { ok: true, pdb };
        return { ok: false, error: 'NVIDIA poll payload missing PDB' };
      }
      const text = await poll.text().catch(() => '');
      return { ok: false, error: `NVIDIA poll ${poll.status}: ${text.slice(0, 200)}` };
    }
    return { ok: false, error: 'NVIDIA poll timed out' };
  }

  const text = await response.text().catch(() => '');
  return { ok: false, error: `NVIDIA ${response.status}: ${text.slice(0, 200)}` };
}

/** Hugging Face Router ESMFold (fallback). */
export async function foldWithHuggingFace(sequence: string): Promise<FoldResult> {
  const apiKey = process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN;
  if (!apiKey) return { ok: false, error: 'HUGGINGFACE_API_KEY not set' };

  let response: Response;
  try {
    response = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        inputs: sequence,
        options: { wait_for_model: true, use_cache: true },
      }),
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }

  const text = await response.text();
  if (response.ok && looksLikePdb(text)) {
    return { ok: true, pdb: text };
  }

  if (response.status === 400 && /not supported|not deployed/i.test(text)) {
    return {
      ok: false,
      error: 'HF router is not currently serving facebook/esmfold_v1',
    };
  }

  return { ok: false, error: `HF ${response.status}: ${text.slice(0, 200)}` };
}

async function runWithRetry(
  engine: 'nvidia-esmfold' | 'hf-esmfold',
  call: (sequence: string) => Promise<FoldResult>,
  sequence: string,
): Promise<CascadeAttempt & { result: FoldResult }> {
  const startedAt = Date.now();
  let last: FoldResult = { ok: false, error: 'no attempts run' };
  let attempts = 0;

  for (let attempt = 0; attempt < PER_ENGINE_MAX_ATTEMPTS; attempt += 1) {
    const backoff = BACKOFF_SCHEDULE_MS[attempt] ?? 30_000;
    if (backoff > 0) await sleep(backoff);

    attempts = attempt + 1;
    last = await callWithTimeout<FoldResult>(call(sequence), PER_ATTEMPT_TIMEOUT_MS, () => ({
      ok: false,
      error: `timed out after ${Math.round(PER_ATTEMPT_TIMEOUT_MS / 1000)}s`,
    }));

    if (last.ok) break;
    if (isPermanentFailure(last.error)) break;
  }

  const durationMs = Date.now() - startedAt;
  return last.ok
    ? { engine, ok: true, durationMs, attempts, result: last }
    : { engine, ok: false, durationMs, attempts, error: last.error, result: last };
}

/**
 * Run the worker's folding cascade with per-engine retries + timeouts.
 *
 * If every configured engine fails the caller can still publish the
 * candidate with `structurePending: true` — fold output is never on
 * the mint critical path.
 */
export async function foldWithCascade(sequence: string): Promise<CascadeOutcome> {
  const attempts: CascadeAttempt[] = [];

  const engines: Array<{
    id: 'nvidia-esmfold' | 'hf-esmfold';
    configured: boolean;
    missingEnv: string;
    call: (sequence: string) => Promise<FoldResult>;
  }> = [
    {
      id: 'nvidia-esmfold',
      configured: Boolean(process.env.NVIDIA_API_KEY),
      missingEnv: 'NVIDIA_API_KEY',
      call: foldWithNvidia,
    },
    {
      id: 'hf-esmfold',
      configured: Boolean(process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN),
      missingEnv: 'HUGGINGFACE_API_KEY',
      call: foldWithHuggingFace,
    },
  ];

  for (const engine of engines) {
    if (!engine.configured) {
      attempts.push({
        engine: engine.id,
        ok: false,
        durationMs: 0,
        attempts: 0,
        error: `${engine.missingEnv} not set`,
      });
      continue;
    }

    const tried = await runWithRetry(engine.id, engine.call, sequence);
    const attempt: CascadeAttempt = {
      engine: tried.engine,
      ok: tried.ok,
      durationMs: tried.durationMs,
      attempts: tried.attempts,
      ...(tried.ok ? {} : { error: tried.error }),
    };
    attempts.push(attempt);

    if (tried.ok && tried.result.ok) {
      return { ok: true, engine: engine.id, pdb: tried.result.pdb, attempts };
    }
  }

  const configured = attempts.filter((a) => !a.error || !/not set$/i.test(a.error));
  const error =
    configured.length === 0
      ? 'No folding engines are configured (set NVIDIA_API_KEY)'
      : 'All folding engines failed after retries';
  return { ok: false, error, attempts };
}
