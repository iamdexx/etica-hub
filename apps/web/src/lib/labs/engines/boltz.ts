/**
 * Boltz folding engine via Replicate.
 *
 * Boltz-1 (from MIT CSAIL) is a structure prediction model for biomolecular
 * interactions — proteins, RNA, DNA, small molecules, and covalent mods.
 * Like Chai-1, it's accessed through Replicate's hosted inference.
 *
 * Requires REPLICATE_API_TOKEN. Free trial credits on replicate.com.
 */

import type { FoldEngine, FoldEngineDescriptor } from './types';
import { looksLikePdb } from './types';

const REPLICATE_API = 'https://api.replicate.com/v1/predictions';
const POLL_INTERVAL_MS = 2_000;
const POLL_BUDGET_MS = 90_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBoltzEngine(): FoldEngine {
  const apiKey = process.env.REPLICATE_API_TOKEN;
  const descriptor: FoldEngineDescriptor = {
    id: 'boltz',
    label: 'Boltz-1',
    model: 'jyaacoub/boltz-1',
    description:
      'Biomolecular structure prediction from MIT CSAIL. Handles proteins, RNA, DNA, and small molecules.',
    isConfigured: Boolean(apiKey),
    requiredEnv: ['REPLICATE_API_TOKEN'],
  };

  return {
    descriptor,
    async fold(sequence) {
      if (!apiKey) return { ok: false, error: 'REPLICATE_API_TOKEN not set' };

      let response: Response;
      try {
        response = await fetch(REPLICATE_API, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            prefer: 'respond-async',
          },
          body: JSON.stringify({
            version: 'jyaacoub/boltz-1',
            input: {
              sequence,
              recycling_steps: 3,
              sampling_steps: 50,
              diffusion_samples: 1,
            },
          }),
          cache: 'no-store',
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'network error' };
      }

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `Replicate ${response.status}: ${text.slice(0, 200)}` };
      }

      let prediction: { id?: string; status?: string; output?: unknown; error?: string };
      try {
        prediction = (await response.json()) as typeof prediction;
      } catch {
        return { ok: false, error: 'Replicate returned non-JSON' };
      }

      if (!prediction.id) {
        return { ok: false, error: prediction.error ?? 'Replicate missing prediction ID' };
      }

      const pollUrl = `${REPLICATE_API}/${prediction.id}`;
      const deadline = Date.now() + POLL_BUDGET_MS;

      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);

        let poll: Response;
        try {
          poll = await fetch(pollUrl, {
            headers: { authorization: `Bearer ${apiKey}` },
            cache: 'no-store',
          });
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'poll error' };
        }

        let status: { status?: string; output?: unknown; error?: string };
        try {
          status = (await poll.json()) as typeof status;
        } catch {
          return { ok: false, error: 'Replicate poll returned non-JSON' };
        }

        if (status.status === 'failed' || status.status === 'canceled') {
          return { ok: false, error: status.error ?? `Boltz prediction ${status.status}` };
        }

        if (status.status === 'succeeded') {
          const output = status.output;
          let pdb: string | null = null;

          if (typeof output === 'string') {
            pdb = output;
          } else if (Array.isArray(output) && typeof output[0] === 'string') {
            pdb = output[0];
          } else if (output && typeof output === 'object') {
            const record = output as Record<string, unknown>;
            if (typeof record.pdb === 'string') pdb = record.pdb;
            else if (typeof record.structure === 'string') pdb = record.structure;
            else if (typeof record.combined_cif === 'string') pdb = record.combined_cif;
          }

          if (pdb && looksLikePdb(pdb)) return { ok: true, pdb };

          if (typeof pdb === 'string' && pdb.startsWith('http')) {
            try {
              const dl = await fetch(pdb, { cache: 'no-store' });
              const text = await dl.text();
              if (looksLikePdb(text)) return { ok: true, pdb: text };
            } catch {
              /* fall through */
            }
          }

          return { ok: false, error: 'Boltz succeeded but output missing PDB' };
        }
      }

      return { ok: false, error: 'Boltz prediction timed out' };
    },
  };
}
