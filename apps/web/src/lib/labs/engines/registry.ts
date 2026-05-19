/**
 * Folding engine registry + cascade orchestrator.
 *
 * The cascade order is fixed at module load: each enabled engine is tried
 * in turn until one returns a valid PDB. We never silently drop attempts
 * from the trace — callers can inspect `attempts[]` to see exactly which
 * engines were tried and why they failed, which is what `/api/labs/fold`
 * surfaces to the UI for the "fold status" panel.
 *
 * Reliability layer:
 *   - Each engine call is wrapped by `runEngineWithRetry`, which retries
 *     transient failures up to 3 times with exponential backoff (0s, 5s,
 *     30s) and enforces a hard per-attempt timeout (90s).
 *   - Engines are ordered NVIDIA-first because NVIDIA NIM ESMFold is the
 *     most stable free host today; HF's serverless router is a fallback
 *     because facebook/esmfold_v1 is currently deprovisioned there.
 */

import { createBoltzEngine } from './boltz';
import { createChai1Engine } from './chai1';
import { createHuggingFaceEsmFoldEngine } from './hf-esmfold';
import { createNvidiaEsmFoldEngine } from './nvidia-esmfold';
import type {
  FoldEngine,
  FoldEngineAttempt,
  FoldEngineDescriptor,
  FoldEngineId,
  FoldOutcome,
} from './types';

/**
 * Default cascade order. NVIDIA-first because the NIM endpoint is currently
 * the most reliable free host for ESMFold; HF's router only intermittently
 * serves facebook/esmfold_v1 today, so it sits in second position as a
 * fallback. Chai-1 and Boltz are paid alternatives that round out the
 * cascade for operators who wire them up.
 */
const CASCADE: readonly FoldEngine[] = [
  createNvidiaEsmFoldEngine(),
  createHuggingFaceEsmFoldEngine(),
  createChai1Engine(),
  createBoltzEngine(),
];

/** Max attempts per engine within a single cascade pass. */
const PER_ENGINE_MAX_ATTEMPTS = 3;
/** Per-attempt hard timeout. Engines wider than this are aborted. */
const PER_ATTEMPT_TIMEOUT_MS = 90_000;
/** Exponential backoff schedule between attempts (length === MAX-1). */
const BACKOFF_SCHEDULE_MS: readonly number[] = [0, 5_000, 30_000];

export function listEngines(): FoldEngineDescriptor[] {
  return CASCADE.map((engine) => engine.descriptor);
}

export function findEngine(id: FoldEngineId): FoldEngine | undefined {
  return CASCADE.find((engine) => engine.descriptor.id === id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type EngineCallResult = { ok: true; pdb: string } | { ok: false; error: string };

/**
 * Race an engine call against a hard timeout. Engines today do not accept
 * an AbortSignal — they manage their own internal polling loops — so we
 * bound them externally with Promise.race. A timed-out attempt is
 * reported as a failure but its in-flight network work continues until
 * the engine's own loop wraps up (harmless: NVIDIA polls a request ID,
 * HF holds a single fetch, both stop on completion).
 */
async function callWithTimeout(
  engine: FoldEngine,
  sequence: string,
  timeoutMs: number,
): Promise<EngineCallResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EngineCallResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([engine.fold(sequence), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Failures we should never retry — clear signal the engine cannot serve us.
 * Anything else (5xx, timeouts, network blips, 429 throttles, "model is
 * loading" cold starts) is retried with backoff.
 */
function isPermanentFailure(error: string): boolean {
  return (
    /not set$/i.test(error) ||
    /not configured/i.test(error) ||
    /not currently serving/i.test(error) ||
    /not (supported|deployed)/i.test(error)
  );
}

/**
 * Run a single engine with retries + per-attempt timeout. Returns the
 * final `EngineCallResult` and the cumulative wall-clock spent across
 * all attempts (used for tracing).
 */
async function runEngineWithRetry(
  engine: FoldEngine,
  sequence: string,
): Promise<{ result: EngineCallResult; durationMs: number; attempts: number }> {
  const startedAt = Date.now();
  let last: EngineCallResult = { ok: false, error: 'no attempts run' };

  for (let attempt = 0; attempt < PER_ENGINE_MAX_ATTEMPTS; attempt += 1) {
    const backoff = BACKOFF_SCHEDULE_MS[attempt] ?? 30_000;
    if (backoff > 0) await sleep(backoff);

    last = await callWithTimeout(engine, sequence, PER_ATTEMPT_TIMEOUT_MS);
    if (last.ok) {
      return { result: last, durationMs: Date.now() - startedAt, attempts: attempt + 1 };
    }
    if (isPermanentFailure(last.error)) {
      return { result: last, durationMs: Date.now() - startedAt, attempts: attempt + 1 };
    }
  }

  return {
    result: last,
    durationMs: Date.now() - startedAt,
    attempts: PER_ENGINE_MAX_ATTEMPTS,
  };
}

/**
 * Run the cascade. If `preferred` is supplied AND configured, that engine
 * is tried first (and exclusively, when `exclusive` is true). Otherwise the
 * default cascade order applies.
 *
 * Each engine is given up to 3 attempts with backoff before falling
 * through to the next engine in the cascade.
 */
export async function foldWithCascade(
  sequence: string,
  options: { preferred?: FoldEngineId; exclusive?: boolean } = {},
): Promise<FoldOutcome> {
  const attempts: FoldEngineAttempt[] = [];
  const { preferred, exclusive = false } = options;

  const order: FoldEngine[] = (() => {
    if (!preferred) return [...CASCADE];
    const head = CASCADE.find((engine) => engine.descriptor.id === preferred);
    if (!head) return [...CASCADE];
    if (exclusive) return [head];
    const rest = CASCADE.filter((engine) => engine.descriptor.id !== preferred);
    return [head, ...rest];
  })();

  for (const engine of order) {
    if (!engine.descriptor.isConfigured) {
      attempts.push({
        engine: engine.descriptor.id,
        ok: false,
        error: `not configured (set ${engine.descriptor.requiredEnv.join(', ')})`,
        durationMs: 0,
      });
      continue;
    }

    const { result, durationMs } = await runEngineWithRetry(engine, sequence);

    if (result.ok) {
      attempts.push({ engine: engine.descriptor.id, ok: true, durationMs });
      return {
        ok: true,
        pdb: result.pdb,
        sequence,
        engine: engine.descriptor.id,
        attempts,
      };
    }

    attempts.push({
      engine: engine.descriptor.id,
      ok: false,
      error: result.error,
      durationMs,
    });
  }

  const configured = attempts.filter((a) => a.error && !a.error.startsWith('not configured'));
  const summary =
    configured.length === 0
      ? 'No folding engines are configured. Set NVIDIA_API_KEY to enable ESMFold.'
      : 'All configured folding engines failed. Please retry in a moment.';

  return { ok: false, error: summary, attempts };
}
