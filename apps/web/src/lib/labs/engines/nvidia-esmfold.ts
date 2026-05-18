/**
 * NVIDIA NIM ESMFold engine.
 *
 * NVIDIA hosts ESMFold behind their inference cloud at
 * `health.api.nvidia.com`. The endpoint is generous (free tier ~1k req/mo)
 * and gives us a meaningful fallback host for the same underlying model
 * when HF's router is cold or rate-limited. Requests are either resolved
 * inline (200) or queued (202 + `nvcf-reqid` header → poll `/status/{id}`).
 *
 * Docs: https://build.nvidia.com/nvidia/esmfold (registration required).
 */

import type { FoldEngine, FoldEngineDescriptor } from './types';
import { looksLikePdb } from './types';

const INVOKE_URL = 'https://health.api.nvidia.com/v1/biology/nvidia/esmfold';
const STATUS_URL = 'https://health.api.nvidia.com/v1/status';
const POLL_INTERVAL_MS = 1_500;
const POLL_BUDGET_MS = 45_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractPdb(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.pdbs) && typeof record.pdbs[0] === 'string') {
    return record.pdbs[0];
  }
  if (typeof record.pdb === 'string') return record.pdb;
  if (typeof record.output === 'string') return record.output;
  return null;
}

export function createNvidiaEsmFoldEngine(): FoldEngine {
  const apiKey = process.env.NVIDIA_API_KEY;
  const descriptor: FoldEngineDescriptor = {
    id: 'nvidia-esmfold',
    label: 'ESMFold (NVIDIA NIM)',
    model: 'facebook/esmfold_v1',
    description:
      'Same ESMFold model hosted on NVIDIA NIM. Used as an automatic failover when the HF router is warming up.',
    isConfigured: Boolean(apiKey),
    requiredEnv: ['NVIDIA_API_KEY'],
  };

  return {
    descriptor,
    async fold(sequence) {
      if (!apiKey) return { ok: false, error: 'NVIDIA_API_KEY not set' };

      let response: Response;
      try {
        response = await fetch(INVOKE_URL, {
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
            poll = await fetch(`${STATUS_URL}/${reqId}`, {
              headers: {
                authorization: `Bearer ${apiKey}`,
                accept: 'application/json',
              },
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
          const text = await poll.text();
          return { ok: false, error: `NVIDIA poll ${poll.status}: ${text.slice(0, 200)}` };
        }

        return { ok: false, error: 'NVIDIA poll timed out' };
      }

      const text = await response.text();
      return { ok: false, error: `NVIDIA ${response.status}: ${text.slice(0, 200)}` };
    },
  };
}
