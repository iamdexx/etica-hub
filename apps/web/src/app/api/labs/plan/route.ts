import { NextRequest } from 'next/server';
import { consumeLabsRateLimit } from '@/lib/labs/rate-limit';
import { gatherReferences, summarizeReferencesForPrompt, type Reference } from '@/lib/labs/research';
import {
  nvidiaChat,
  NvidiaError,
  NVIDIA_MODEL_PRIMARY,
  hasNvidiaKey,
} from '@/lib/labs/nvidia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel Pro plan ceiling. A full 3-candidate 550B plan has highly
// variable latency in production (~60s up to ~170s under load); the old
// 30s cap timed out every manual fold request. 300s leaves headroom for
// the 240s per-call budget plus response serialisation.
export const maxDuration = 300;

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

  if (!hasNvidiaKey()) {
    return json(
      { error: 'Nvidia API key is not configured.', comingSoon: true },
      { status: 503, headers: limit.headers },
    );
  }

  // Pull in related public research first so the planner builds on existing
  // work instead of duplicating it. Both lookups are short-timeout and fail
  // open: if PubMed/PDB are slow we still plan, just without their context.
  const references: Reference[] = await gatherReferences(prompt).catch(() => []);
  const refSummary = summarizeReferencesForPrompt(references);

  try {
    // 'detailed thinking off' must be on its own line for the model to
    // recognise the directive and skip its verbose chain-of-thought.
    const systemPrompt = 'detailed thinking off\n' + [
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
      'BE TERSE: every text field must be a single short clause; rationales under 18 words. Output minified JSON and stop immediately after the closing brace — do not keep writing.',
    ].join(' ');

    const userContent = refSummary
      ? `Goal: ${prompt}\n\nExisting research and structures (cite by [N] index):\n${refSummary}`
      : prompt;

    // nvidiaChat handles the (key × model × jsonMode) cascade and retries
    // on 429/5xx with exponential backoff. tryParsePlan is tolerant — it
    // pulls the outermost {...} substring — so we still get a plan back
    // when the API emits json_validate_failed.
    let lastRaw = '';
    // Single 550B pass. nvidiaChat treats timeoutMs as a total budget across
    // its internal retries, so a second identical-model pass would only
    // double the wall-clock pressure against the 300s function ceiling.
    // One pass with a 240s budget absorbs the observed latency variance
    // (~60s up to ~170s) and still returns well inside maxDuration.
    const models = [NVIDIA_MODEL_PRIMARY];
    for (const model of models) {
      try {
        const result = await nvidiaChat({
          models: [model],
          temperature: 0.4,
          // Ceiling, not a target: thinking-off + terse schema stop 550B at
          // ~650 tok; 1400 only guards against truncating a valid plan with
          // three long (≤400-residue) sequences.
          max_tokens: 1400,
          jsonMode: true,
          timeoutMs: 240_000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        });
        lastRaw = result.content;
        const plan = tryParsePlan(result.content);
        if (plan) {
          return json(
            { plan, references, provider: 'nvidia', model: result.model },
            { headers: limit.headers },
          );
        }
      } catch (err) {
        if (err instanceof NvidiaError && model === models[models.length - 1]) {
          return json(
            {
              error: `Nvidia planning failed (${err.status}).`,
              detail: (err.detail ?? err.message).slice(0, 240),
            },
            { status: 502, headers: limit.headers },
          );
        }
      }
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
  }
}
