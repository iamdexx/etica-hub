/**
 * Folding engine registry + cascade orchestrator.
 *
 * The cascade order is fixed at module load: each enabled engine is tried
 * in turn until one returns a valid PDB. We never silently drop attempts
 * from the trace — callers can inspect `attempts[]` to see exactly which
 * engines were tried and why they failed, which is what `/api/labs/fold`
 * surfaces to the UI for the "fold status" panel.
 */

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
 * Default cascade order. Primary first, then automatic fallbacks. The order
 * is stable across deploys so behaviour stays predictable for users.
 */
const CASCADE: readonly FoldEngine[] = [
  createHuggingFaceEsmFoldEngine(),
  createNvidiaEsmFoldEngine(),
];

export function listEngines(): FoldEngineDescriptor[] {
  return CASCADE.map((engine) => engine.descriptor);
}

export function findEngine(id: FoldEngineId): FoldEngine | undefined {
  return CASCADE.find((engine) => engine.descriptor.id === id);
}

/**
 * Run the cascade. If `preferred` is supplied AND configured, that engine
 * is tried first (and exclusively, when `exclusive` is true). Otherwise the
 * default cascade order applies.
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

    const startedAt = Date.now();
    const result = await engine.fold(sequence);
    const durationMs = Date.now() - startedAt;

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
      ? 'No folding engines are configured. Set HUGGINGFACE_API_KEY to enable ESMFold.'
      : 'All configured folding engines failed. Please retry in a moment.';

  return { ok: false, error: summary, attempts };
}
