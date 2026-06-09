import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import {
  groqChat,
  GroqError,
  GROQ_MODEL_PRIMARY,
  GROQ_MODEL_FALLBACK,
  hasGroqKey,
} from '@/lib/labs/nvidia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

  if (!hasGroqKey()) {
    return json(
      { error: 'Groq API key is not configured.', comingSoon: true },
      { status: 503, headers: limit.headers },
    );
  }

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

    // Explanation is short and tolerant of model quality, so prefer the
    // 8B model (much higher daily cap) and cascade up to 70B only if 8B
    // burns through retries. groqChat rotates keys + retries 429/5xx.
    const result = await groqChat({
      models: [GROQ_MODEL_FALLBACK, GROQ_MODEL_PRIMARY],
      temperature: 0.3,
      max_tokens: 512,
      timeoutMs: 20_000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    if (!result.content) {
      return json({ error: 'AI returned empty analysis.' }, { status: 502, headers: limit.headers });
    }

    return json({ analysis: result.content, model: result.model }, { headers: limit.headers });
  } catch (err) {
    if (err instanceof GroqError) {
      return json(
        { error: 'AI analysis failed.', detail: (err.detail ?? err.message).slice(0, 240) },
        { status: 502, headers: limit.headers },
      );
    }
    return json({ error: 'AI analysis request timed out.' }, { status: 502, headers: limit.headers });
  }
}
