/**
 * ESM Atlas ESMFold engine (Meta's public fold API).
 *
 * Keyless and always configured, which makes it the cascade's floor: when
 * NVIDIA retires its NIM function or HF deprovisions esmfold_v1, this is
 * what keeps candidates folding instead of publishing sequence-only scores.
 *
 * The endpoint takes the bare sequence as the request body and answers with
 * a PDB whose B-factor column carries pLDDT on a 0-1 scale (NVIDIA/HF use
 * 0-100); `parseCaTrace` in pdb-render.ts rescales it.
 */

import type { FoldEngine, FoldEngineDescriptor } from './types';
import { looksLikePdb } from './types';

const ESMATLAS_URL = 'https://api.esmatlas.com/foldSequence/v1/pdb/';
const MAX_RESIDUES = 400;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEsmAtlasEngine(): FoldEngine {
  const descriptor: FoldEngineDescriptor = {
    id: 'esmatlas',
    label: 'ESMFold (ESM Atlas)',
    model: 'esmfold_v1',
    description:
      "Meta's public ESMFold endpoint. Keyless and sequence-only, capped at 400 residues.",
    isConfigured: true,
    requiredEnv: [],
  };

  return {
    descriptor,
    async fold(sequence) {
      if (sequence.length > MAX_RESIDUES) {
        return { ok: false, error: `ESM Atlas is not supported above ${MAX_RESIDUES} residues` };
      }

      let lastError = 'Unknown error';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await fetch(ESMATLAS_URL, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: sequence,
            cache: 'no-store',
          });
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'network error';
          await sleep(2_000);
          continue;
        }

        const text = await response.text();
        if (response.ok && looksLikePdb(text)) return { ok: true, pdb: text };

        lastError = `ESM Atlas ${response.status}: ${text.slice(0, 240)}`;
        if (RETRYABLE_STATUS.has(response.status)) {
          await sleep(Math.min(15_000, 2_500 * (attempt + 1)));
          continue;
        }
        return { ok: false, error: lastError };
      }
      return { ok: false, error: lastError };
    },
  };
}
