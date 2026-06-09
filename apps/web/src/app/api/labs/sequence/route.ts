import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import {
  nvidiaChat,
  NvidiaError,
  NVIDIA_MODEL_PRIMARY,
  NVIDIA_MODEL_FALLBACK,
  hasNvidiaKey,
} from '@/lib/labs/nvidia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const MAX_PROMPT_CHARS = 400;
const MAX_SEQUENCE_LENGTH = 400;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function fallbackExtractSequence(prompt: string): string | null {
  const upper = prompt.toUpperCase();
  const candidates = upper.match(/[ACDEFGHIKLMNPQRSTVWY]{10,400}/g) ?? [];
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

function normalizeSequence(value: string): string | null {
  const sequence = value.toUpperCase().replace(/[^ACDEFGHIKLMNPQRSTVWY]/g, '');
  if (sequence.length < 10 || sequence.length > MAX_SEQUENCE_LENGTH) return null;
  if (!AMINO_ACIDS.test(sequence)) return null;
  return sequence;
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);

  if (!limit.ok) {
    return json(limit.body, {
      status: limit.status,
      headers: limit.headers,
    });
  }

  let body: { prompt?: unknown };
  try {
    body = (await req.json()) as { prompt?: unknown };
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: 'Prompt is required.' }, { status: 400, headers: limit.headers });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(
      { error: `Prompt must be ${MAX_PROMPT_CHARS} characters or fewer.` },
      { status: 400, headers: limit.headers },
    );
  }

  // Always try the local extractor first — if the prompt already contains a
  // raw amino-acid sequence we don't need to spend an API call on it.
  // This also acts as the ultimate fallback if Nvidia is unreachable.
  const localFallback = (): { sequence: string } | null => {
    const raw = fallbackExtractSequence(prompt);
    const seq = raw ? normalizeSequence(raw) : null;
    return seq ? { sequence: seq } : null;
  };

  if (!hasNvidiaKey()) {
    const fallback = localFallback();
    if (!fallback) {
      return json(
        {
          error: 'Nvidia API key is not configured and no raw amino-acid sequence could be extracted.',
          comingSoon: true,
        },
        { status: 503, headers: limit.headers },
      );
    }
    return json({ ...fallback, provider: 'local-extractor' }, { headers: limit.headers });
  }

  try {
    // nvidiaChat handles retry + backoff on 429/5xx.
    const result = await nvidiaChat({
      models: [NVIDIA_MODEL_FALLBACK, NVIDIA_MODEL_PRIMARY],
      temperature: 0,
      max_tokens: 256,
      timeoutMs: 20_000,
      messages: [
        {
          role: 'system',
          content:
            'Extract or design exactly one valid amino-acid sequence from the user request. Return only uppercase one-letter amino acid codes. No markdown, spaces, labels, punctuation, or explanation. Allowed letters: ACDEFGHIKLMNPQRSTVWY. Length must be between 10 and 400 residues.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const sequence =
      normalizeSequence(result.content) ??
      normalizeSequence(fallbackExtractSequence(result.content) ?? '');

    if (!sequence) {
      const fallback = localFallback();
      if (fallback) {
        return json({ ...fallback, provider: 'local-extractor' }, { headers: limit.headers });
      }
      return json(
        { error: 'Could not produce a valid amino-acid sequence.' },
        { status: 422, headers: limit.headers },
      );
    }

    return json(
      { sequence, provider: 'nvidia', model: result.model },
      { headers: limit.headers },
    );
  } catch (err) {
    // If Nvidia is fully exhausted, fall back to the local extractor before
    // giving up — prompts often contain raw sequences anyway.
    const fallback = localFallback();
    if (fallback) {
      return json({ ...fallback, provider: 'local-extractor' }, { headers: limit.headers });
    }
    if (err instanceof NvidiaError) {
      return json(
        { error: 'Nvidia sequence extraction failed.', detail: (err.detail ?? err.message).slice(0, 240) },
        { status: 502, headers: limit.headers },
      );
    }
    return json({ error: 'Nvidia request timed out or failed.' }, { status: 502, headers: limit.headers });
  }
}
