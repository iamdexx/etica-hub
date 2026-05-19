/**
 * NVIDIA NIM ESMFold call from the worker. Mirrors the engine in
 * apps/web/src/lib/labs/engines/nvidia-esmfold.ts — we deliberately keep
 * a thin worker-side copy so the autopilot stays independent of the
 * Next.js bundle.
 *
 * Same model as HF ESMFold, just routed through NVIDIA's free-tier NIM
 * cloud (which is what /api/labs/fold falls back to now that HF stopped
 * serving facebook/esmfold_v1).
 */

const INVOKE_URL = 'https://health.api.nvidia.com/v1/biology/nvidia/esmfold';
const STATUS_URL = 'https://health.api.nvidia.com/v1/status';
const POLL_INTERVAL_MS = 1_500;
const POLL_BUDGET_MS = Number(process.env.LABS_AUTOPILOT_FOLD_TIMEOUT_MS ?? '60000');

export type FoldResult = { ok: true; pdb: string } | { ok: false; error: string };

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

export async function foldWithNvidia(sequence: string): Promise<FoldResult> {
  const apiKey = process.env.NVIDIA_API_KEY;
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
