import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);

  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  let body: { sequence?: unknown; prompt?: unknown };
  try {
    body = (await req.json()) as { sequence?: unknown; prompt?: unknown };
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const sequence = typeof body.sequence === 'string' ? body.sequence.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

  if (!sequence) {
    return json({ error: 'Sequence is required.' }, { status: 400, headers: limit.headers });
  }

  const apiKey = process.env.AIBOT_LLM_GROQ_API_KEY ?? process.env.GROQ_API_KEY;

  if (!apiKey) {
    return json(
      { error: 'Groq API key is not configured.', comingSoon: true },
      { status: 503, headers: limit.headers },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const systemPrompt = [
      'You are a structural biologist AI assistant.',
      'The user has just folded a peptide sequence. Analyze it concisely.',
      'Cover: (1) likely secondary structure motifs (alpha-helix, beta-sheet, loops),',
      '(2) notable residue patterns (hydrophobic cores, charged patches, disulfide candidates),',
      '(3) possible biological function or application based on the sequence composition,',
      '(4) stability considerations.',
      'Keep the response under 250 words. Use clear scientific language accessible to a graduate student.',
      'Do not use markdown headers. Use short paragraphs.',
    ].join(' ');

    const userContent = prompt
      ? `Original design prompt: "${prompt}"\n\nFolded sequence (${sequence.length} residues): ${sequence}`
      : `Folded sequence (${sequence.length} residues): ${sequence}`;

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      return json({ error: 'AI analysis failed.' }, { status: 502, headers: limit.headers });
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const analysis = payload.choices?.[0]?.message?.content?.trim() ?? '';

    if (!analysis) {
      return json({ error: 'AI returned empty analysis.' }, { status: 502, headers: limit.headers });
    }

    return json({ analysis, model: MODEL }, { headers: limit.headers });
  } catch {
    return json({ error: 'AI analysis request timed out.' }, { status: 502, headers: limit.headers });
  } finally {
    clearTimeout(timeout);
  }
}
