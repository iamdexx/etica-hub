import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import { foldWithCascade } from '@/lib/labs/engines/registry';
import type { FoldEngineId } from '@/lib/labs/engines/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const KNOWN_ENGINES = new Set<FoldEngineId>(['hf-esmfold', 'nvidia-esmfold', 'chai-1', 'boltz']);

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);

  if (!limit.ok) {
    return json(limit.body, {
      status: limit.status,
      headers: limit.headers,
    });
  }

  let body: { sequence?: unknown; engine?: unknown; exclusive?: unknown };

  try {
    body = (await req.json()) as { sequence?: unknown; engine?: unknown; exclusive?: unknown };
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const sequence = typeof body.sequence === 'string' ? body.sequence.trim().toUpperCase() : '';

  if (!sequence || !AMINO_ACIDS.test(sequence)) {
    return json(
      { error: 'A valid amino-acid sequence is required.' },
      { status: 400, headers: limit.headers },
    );
  }

  if (sequence.length > 400) {
    return json(
      { error: 'Sequence too large for free-tier folding.' },
      { status: 400, headers: limit.headers },
    );
  }

  const preferred =
    typeof body.engine === 'string' && KNOWN_ENGINES.has(body.engine as FoldEngineId)
      ? (body.engine as FoldEngineId)
      : undefined;
  const exclusive = body.exclusive === true;

  const outcome = await foldWithCascade(sequence, { preferred, exclusive });

  if (outcome.ok) {
    return json(
      {
        pdb: outcome.pdb,
        sequence: outcome.sequence,
        engine: outcome.engine,
        provider: outcome.engine,
        attempts: outcome.attempts,
      },
      { headers: limit.headers },
    );
  }

  const anyConfiguredAttempted = outcome.attempts.some(
    (a) => !a.error?.startsWith('not configured'),
  );

  return json(
    {
      error: outcome.error,
      attempts: outcome.attempts,
      warming: anyConfiguredAttempted,
    },
    {
      status: anyConfiguredAttempted ? 503 : 503,
      headers: limit.headers,
    },
  );
}
