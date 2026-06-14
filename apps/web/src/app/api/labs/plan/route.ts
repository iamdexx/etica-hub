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

function stripReasoning(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
}

function decodeJsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }
}

function extractField(raw: string, keys: string[]): string {
  for (const key of keys) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (m && m[1] !== undefined) return decodeJsonString(m[1]);
  }
  return '';
}

/**
 * Recover candidate sequences even from truncated JSON: each completed
 * `"sequence":"…"` pair is matched independently, so a tail cut off at the
 * token cap still yields the earlier complete candidates. Amino-acid strings
 * never contain quotes, so `[^"]*` is a safe body matcher.
 */
function salvageCandidates(raw: string): PlanCandidate[] {
  const out: PlanCandidate[] = [];
  const seqRe = /"sequence"\s*:\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = seqRe.exec(raw)) && out.length < 5) {
    const sequence = normalizeSequence(m[1]);
    if (!sequence) continue;
    const after = raw.slice(seqRe.lastIndex, seqRe.lastIndex + 600);
    const ratM = /"rationale"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(after);
    const rationale = ratM && ratM[1] !== undefined ? clampText(decodeJsonString(ratM[1]), 220) : '';
    out.push({ sequence, rationale });
  }
  return out;
}

function strictParsePlan(raw: string): ResearchPlan | null {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
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

/**
 * Parse the planner response. Strict JSON parse first; if the response was
 * truncated at the token cap (three long sequences) or wrapped in reasoning
 * text, fall back to a regex salvage that recovers the completed candidates so
 * the request still returns a usable plan instead of a 422.
 */
function parseVariant(raw: string): ResearchPlan | null {
  const strict = strictParsePlan(raw);
  if (strict) return strict;

  const candidates = salvageCandidates(raw);
  if (candidates.length === 0) return null;
  const hypothesis = clampText(extractField(raw, ['hypothesis']), 320);
  const approach = clampText(extractField(raw, ['approach']), 480);
  if (!hypothesis && !approach) return null;
  return {
    hypothesis,
    approach,
    successCriteria: clampText(extractField(raw, ['successCriteria', 'success_criteria']), 320),
    risks: clampText(extractField(raw, ['risks']), 320),
    candidates,
  };
}

function tryParsePlan(raw0: string): ResearchPlan | null {
  if (!raw0) return null;
  const raw = stripReasoning(raw0);
  const direct = parseVariant(raw);
  if (direct) return direct;
  // `json_object` responses sometimes come back with every quote
  // backslash-escaped (`{\"hypothesis\":\"…`); unescaping restores valid
  // structure. Sequences/rationales never contain quotes, so this is lossless.
  if (raw.includes('\\"')) {
    const unescaped = parseVariant(raw.replace(/\\"/g, '"'));
    if (unescaped) return unescaped;
  }
  return null;
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
    // Nemotron 550B only honours the reasoning switch when it is its OWN
    // system message — concatenated with other text it narrates to the token
    // cap and the JSON never closes. A compact schema + forcing the reply to
    // start at `{` makes it emit minified JSON immediately instead of prose.
    const THINKING_OFF = 'detailed thinking off';
    const instructions = [
      'You are a protein-engineering planner. Output ONLY a single minified JSON object — no prose, no reasoning, no markdown, no code fences. Begin your reply with { and write nothing before it.',
      'The object has keys: "hypothesis" (1 short sentence), "approach" (1-2 short sentences), "successCriteria" (1 sentence), "risks" (1 sentence), and "candidates" (an array of exactly 3 objects, each {"sequence","rationale"}). "sequence" = one-letter amino acids only from ACDEFGHIKLMNPQRSTVWY, 40-120 residues. "rationale" = under 15 words and may cite a [N] reference.',
      'Design NOVEL sequences; never copy known or patented drug sequences. If references are provided, build on them and cite the [N] index.',
      'End your reply with } and write nothing after it.',
    ].join(' ');

    const userContent = refSummary
      ? `Goal: ${prompt}\n\nExisting research and structures (cite by [N] index):\n${refSummary}`
      : prompt;

    // nvidiaChat handles the (key × model × jsonMode) cascade and retries
    // on 429/5xx with exponential backoff. tryParsePlan is tolerant — it
    // pulls the outermost {...} substring — so we still get a plan back
    // when the API emits json_validate_failed.
    let lastRaw = '';
    let lastErr: NvidiaError | null = null;
    // The 'detailed thinking off' switch is stochastic — a minority of samples
    // narrate a reasoning preamble that eats the token budget and truncates the
    // JSON before `candidates`, which the salvage parser can't recover. Retry
    // within a wall-clock deadline so a bad sample doesn't surface as a 422.
    // Each pass is one shot (maxRetriesPerKey: 1) capped so two passes stay
    // under the 300s function ceiling; a clean plan returns in ~120-145s.
    const deadline = Date.now() + 290_000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 60_000) break; // not enough budget for another full pass
      try {
        const result = await nvidiaChat({
          models: [NVIDIA_MODEL_PRIMARY],
          temperature: 0.4,
          // Ceiling, not a target. A clean minified 3-sequence plan lands at
          // ~600-1550 tokens; 2048 leaves headroom and the salvage parser
          // recovers candidates if a response still overruns.
          max_tokens: 2048,
          // Plain mode: `json_object` makes this model emit mangled/over-escaped
          // JSON. With the forceful prompt it returns clean minified JSON.
          jsonMode: false,
          timeoutMs: Math.min(145_000, remaining),
          maxRetriesPerKey: 1, // one shot per pass; the loop drives the retries
          messages: [
            { role: 'system', content: THINKING_OFF },
            { role: 'system', content: instructions },
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
        if (err instanceof NvidiaError) lastErr = err;
      }
    }

    if (lastErr && !lastRaw) {
      return json(
        {
          error: `Nvidia planning failed (${lastErr.status}).`,
          detail: (lastErr.detail ?? lastErr.message).slice(0, 240),
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
  }
}
