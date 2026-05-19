import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import { gatherReferences, summarizeReferencesForPrompt, type Reference } from '@/lib/labs/research';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Use the 70B versatile model for primary calls — it's far more reliable at
// producing valid JSON than the 8B instant model, which intermittently fails
// Groq's server-side JSON validator when response_format=json_object is set.
const MODEL_PRIMARY = 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = 'llama-3.1-8b-instant';
const MAX_PROMPT_CHARS = 400;
const AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const MAX_SEQUENCE_LENGTH = 400;
const MIN_SEQUENCE_LENGTH = 10;

type PlanCandidate = {
  sequence: string;
  rationale: string;
};

type ResearchPlan = {
  hypothesis: string;
  approach: string;
  successCriteria: string;
  risks: string;
  candidates: PlanCandidate[];
};

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function normalizeSequence(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sequence = value.toUpperCase().replace(/[^ACDEFGHIKLMNPQRSTVWY]/g, '');
  if (sequence.length < MIN_SEQUENCE_LENGTH || sequence.length > MAX_SEQUENCE_LENGTH) return null;
  if (!AMINO_ACIDS.test(sequence)) return null;
  return sequence;
}

function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}\u2026` : trimmed;
}

function tryParsePlan(raw: string): ResearchPlan | null {
  if (!raw) return null;
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = raw.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  const hypothesis = clampText(p.hypothesis, 320);
  const approach = clampText(p.approach, 480);
  const successCriteria = clampText(p.successCriteria ?? p.success_criteria, 320);
  const risks = clampText(p.risks, 320);

  if (!hypothesis && !approach) return null;

  const rawCandidates = Array.isArray(p.candidates) ? p.candidates : [];
  const candidates: PlanCandidate[] = [];
  for (const c of rawCandidates) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    const sequence = normalizeSequence(rec.sequence);
    if (!sequence) continue;
    const rationale = clampText(rec.rationale, 220);
    candidates.push({ sequence, rationale });
    if (candidates.length >= 5) break;
  }

  if (candidates.length === 0) return null;

  return { hypothesis, approach, successCriteria, risks, candidates };
}

export async function POST(req: NextRequest): Promise<Response> {
  const limit = await consumeLabsRateLimit(req);

  if (!limit.ok) {
    return json(limit.body, { status: limit.status, headers: limit.headers });
  }

  let body: { prompt?: unknown };
  try {
    body = (await req.json()) as { prompt?: unknown };
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: limit.headers });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return json({ error: 'Prompt is required.' }, { status: 400, headers: limit.headers });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(
      { error: `Prompt must be ${MAX_PROMPT_CHARS} characters or fewer.` },
      { status: 400, headers: limit.headers },
    );
  }

  const apiKey = process.env.AIBOT_LLM_GROQ_API_KEY ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    return json(
      { error: 'Groq API key is not configured.', comingSoon: true },
      { status: 503, headers: limit.headers },
    );
  }

  // Pull in related public research first so the planner builds on existing
  // work instead of duplicating it. Both lookups are short-timeout and fail
  // open: if PubMed/PDB are slow we still plan, just without their context.
  const references: Reference[] = await gatherReferences(prompt).catch(() => []);
  const refSummary = summarizeReferencesForPrompt(references);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const systemPrompt = [
      'You are a protein-engineering planner.',
      'Given a natural-language design goal, output a concise research plan as STRICT JSON with this exact schema:',
      '{',
      '  "hypothesis": "<1-2 sentences on the structural/functional hypothesis>",',
      '  "approach": "<2-3 sentences on the design strategy: motifs, scaffolds, residue choices>",',
      '  "successCriteria": "<one sentence on how to recognize a successful candidate>",',
      '  "risks": "<one sentence on the biggest failure mode or off-target risk>",',
      '  "candidates": [',
      '    { "sequence": "<one-letter amino acid codes, 10-400 residues, only ACDEFGHIKLMNPQRSTVWY>",',
      '      "rationale": "<one short sentence explaining this candidate; cite [N] references where relevant>" }',
      '  ]',
      '}',
      'Generate exactly 3 candidate sequences that follow the user goal (length, prefix, motifs).',
      'IMPORTANT: do not duplicate prior work. If references are provided below, treat them as the state of the art and build on them — cite the bracketed [N] index in your candidates\' rationale (e.g. "adapts the helix bundle of [2]") and differentiate each candidate from the cited structures/papers.',
      'Return ONLY the JSON object. No markdown, no code fences, no commentary.',
    ].join(' ');

    const userContent = refSummary
      ? `Goal: ${prompt}\n\nExisting research and structures (cite by [N] index):\n${refSummary}`
      : prompt;

    /**
     * Groq occasionally returns 400 with `json_validate_failed` when
     * response_format=json_object is set and the model emits text that
     * doesn't strictly parse — especially on the 8B model. To make the
     * planner reliable on mobile/LTE, we run a 3-attempt cascade:
     *
     *   1. primary model (70B) with strict json_object response_format
     *   2. primary model (70B) WITHOUT response_format (tolerate parser)
     *   3. fallback model (8B) WITHOUT response_format
     *
     * `tryParsePlan` is already tolerant — it pulls the outermost `{...}`
     * substring and json-parses that — so dropping response_format is safe.
     */
    type Attempt = { model: string; useJsonMode: boolean };
    const attempts: Attempt[] = [
      { model: MODEL_PRIMARY, useJsonMode: true },
      { model: MODEL_PRIMARY, useJsonMode: false },
      { model: MODEL_FALLBACK, useJsonMode: false },
    ];

    let lastStatus = 0;
    let lastDetail = '';
    let lastRaw = '';
    let usedModel = MODEL_PRIMARY;

    for (const attempt of attempts) {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: attempt.model,
          temperature: 0.4,
          max_tokens: 1200,
          ...(attempt.useJsonMode
            ? { response_format: { type: 'json_object' } }
            : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok) {
        lastStatus = response.status;
        lastDetail = await response.text().catch(() => '');
        continue;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const raw = payload.choices?.[0]?.message?.content?.trim() ?? '';
      lastRaw = raw;
      usedModel = attempt.model;
      const plan = tryParsePlan(raw);
      if (plan) {
        return json(
          { plan, references, provider: 'groq', model: usedModel },
          { headers: limit.headers },
        );
      }
    }

    if (lastStatus && lastStatus !== 200) {
      return json(
        {
          error: `Groq planning failed (${lastStatus}).`,
          detail: lastDetail.slice(0, 240),
        },
        { status: 502, headers: limit.headers },
      );
    }

    return json(
      {
        error: 'Planner returned an unparseable response. Try again or refine the prompt.',
        raw: lastRaw.slice(0, 400),
      },
      { status: 422, headers: limit.headers },
    );
  } catch {
    return json(
      { error: 'Planner request timed out or failed.' },
      { status: 502, headers: limit.headers },
    );
  } finally {
    clearTimeout(timeout);
  }
}
