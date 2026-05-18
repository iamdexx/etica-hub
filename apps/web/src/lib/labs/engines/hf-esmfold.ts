/**
 * Hugging Face Router ESMFold engine.
 *
 * This is the primary folding path for Labs. ESMFold is sequence-only
 * (no MSA), single-call, and exposed via HF's serverless router for free
 * once an HF token is configured. The endpoint is occasionally cold —
 * we issue a short bounded retry loop before giving up and letting the
 * cascade fall through to the next engine.
 */

import type { FoldEngine, FoldEngineDescriptor } from './types';
import { looksLikePdb } from './types';

const HF_URL = 'https://router.huggingface.co/hf-inference/models/facebook/esmfold_v1';
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function readApiKey(): string | undefined {
  return process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN;
}

export function createHuggingFaceEsmFoldEngine(): FoldEngine {
  const apiKey = readApiKey();
  const descriptor: FoldEngineDescriptor = {
    id: 'hf-esmfold',
    label: 'ESMFold (Hugging Face)',
    model: 'facebook/esmfold_v1',
    description:
      'Sequence-only folding via the HF serverless router. Fast and free at the price of cold-start warming.',
    isConfigured: Boolean(apiKey),
    requiredEnv: ['HUGGINGFACE_API_KEY'],
  };

  return {
    descriptor,
    async fold(sequence) {
      if (!apiKey) return { ok: false, error: 'HUGGINGFACE_API_KEY not set' };

      let lastError = 'Unknown error';

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
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
          lastError = err instanceof Error ? err.message : 'network error';
          await sleep(2_000);
          continue;
        }

        const text = await response.text();
        if (response.ok && looksLikePdb(text)) {
          return { ok: true, pdb: text };
        }

        // Detect "Model not supported" — HF currently has esmfold_v1 deprovisioned
        // from the inference router. There's no point retrying; surface a clear
        // message so the cascade can move on.
        if (response.status === 400 && /not supported|not deployed/i.test(text)) {
          return {
            ok: false,
            error: 'HF inference router is not currently serving facebook/esmfold_v1. Try another engine.',
          };
        }

        lastError = `HF ${response.status}: ${text.slice(0, 240)}`;

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
