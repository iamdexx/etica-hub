import { NextRequest } from 'next/server';

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
  let body: { sequence?: unknown };
  try {
    body = (await req.json()) as { sequence?: unknown };
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const sequence = typeof body.sequence === 'string' ? body.sequence.trim().toUpperCase() : '';

  if (!sequence || !AMINO_ACIDS.test(sequence)) {
    return json({ error: 'A valid amino-acid sequence is required.' }, { status: 400 });
  }

  if (sequence.length > 400) {
    return json({ error: 'Sequence too large for free-tier folding.' }, { status: 400 });
  }

  const apiKey = process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN;

  if (!apiKey) {
    return json(
      {
        error: 'Hugging Face API key is not configured yet.',
        comingSoon: true,
      },
      { status: 503 },
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
      return json({ pdb, sequence, provider: 'huggingface-esmfold' });
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
      { status: 502 },
    );
  }

  return json(
    {
      error: 'Model is still warming up. Try again shortly.',
      warming: true,
    },
    { status: 503 },
  );
}
