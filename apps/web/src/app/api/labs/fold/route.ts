import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HF_URL = 'https://api-inference.huggingface.co/models/facebook/esmfold_v1';
const AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);

  if (!limit.ok) {
    return json(limit.body, {
      status: limit.status,
      headers: limit.headers,
    });
  }

  let body: { sequence?: unknown };
  try {
    body = (await req.json()) as { sequence?: unknown };
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const sequence = typeof body.sequence === 'string' ? body.sequence.trim().toUpperCase() : '';

  if (!sequence || !AMINO_ACIDS.test(sequence)) {
    return json({ error: 'A valid amino-acid sequence is required.' }, { status: 400, headers: limit.headers });
  }

  if (sequence.length > 400) {
    return json({ error: 'Sequence too large for free-tier folding.' }, { status: 400, headers: limit.headers });
  }

  const apiKey = process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN;

  if (!apiKey) {
    return json(
      {
        error: 'Hugging Face API key is not configured yet.',
        comingSoon: true,
      },
      { status: 503, headers: limit.headers },
    );
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inputs: sequence }),
      cache: 'no-store',
    });

    if (response.ok) {
      const pdb = await response.text();
      return json({ pdb, sequence, provider: 'huggingface-esmfold' }, { headers: limit.headers });
    }

    if (response.status === 503) {
      await sleep(5000);
      continue;
    }

    const text = await response.text();
    return json(
      {
        error: 'Folding request failed.',
        detail: text.slice(0, 500),
      },
      { status: 502, headers: limit.headers },
    );
  }

  return json(
    {
      error: 'Model is still warming up. Try again shortly.',
      warming: true,
    },
    { status: 503, headers: limit.headers },
  );
}
