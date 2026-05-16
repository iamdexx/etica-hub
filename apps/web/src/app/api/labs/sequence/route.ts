import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';
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

  const apiKey = process.env.AIBOT_LLM_GROQ_API_KEY ?? process.env.GROQ_API_KEY;

  if (!apiKey) {
    const fallback = fallbackExtractSequence(prompt);
    const sequence = fallback ? normalizeSequence(fallback) : null;
    if (!sequence) {
      return json(
        {
          error: 'Groq is not configured yet and no raw amino-acid sequence could be extracted.',
          comingSoon: true,
        },
        { status: 503, headers: limit.headers },
      );
    }
    return json({ sequence, provider: 'local-extractor' }, { headers: limit.headers });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 256,
        messages: [
          {
            role: 'system',
            content:
              'Extract or design exactly one valid amino-acid sequence from the user request. Return only uppercase one-letter amino acid codes. No markdown, spaces, labels, punctuation, or explanation. Allowed letters: ACDEFGHIKLMNPQRSTVWY. Length must be between 10 and 400 residues.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      return json({ error: 'Groq sequence extraction failed.' }, { status: 502, headers: limit.headers });
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const raw = payload.choices?.[0]?.message?.content ?? '';
    const sequence = normalizeSequence(raw) ?? normalizeSequence(fallbackExtractSequence(raw) ?? '');

    if (!sequence) {
      return json(
        { error: 'Could not produce a valid amino-acid sequence.' },
        { status: 422, headers: limit.headers },
      );
    }

    return json({ sequence, provider: 'groq', model: MODEL }, { headers: limit.headers });
  } catch {
    return json({ error: 'Groq request timed out or failed.' }, { status: 502, headers: limit.headers });
  } finally {
    clearTimeout(timeout);
  }
}
