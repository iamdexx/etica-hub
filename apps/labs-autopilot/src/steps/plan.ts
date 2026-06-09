/**
 * Worker-side research plan generation. Mirrors the prompt + JSON schema
 * of `/api/labs/plan` but runs from the GitHub Actions worker against
 * Groq + PubMed + RCSB PDB directly.
 *
 * Why duplicate the Vercel route: the worker doesn't go through Vercel,
 * so it cannot inherit the route's secrets. Keeping a thin worker-side
 * copy keeps the autopilot independent of any Next.js bundling.
 */

import {
  groqChat,
  GroqError,
  GROQ_MODEL_PRIMARY,
  GROQ_MODEL_FALLBACK,
  readGroqKeyPool,
} from '../nvidia';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const RCSB_SEARCH = 'https://search.rcsb.org/rcsbsearch/v2/query';

const AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const MAX_SEQUENCE_LENGTH = 400;
const MIN_SEQUENCE_LENGTH = 10;

export type Reference = {
  source: 'pubmed' | 'pdb';
  id: string;
  title: string;
  detail: string;
  url: string;
};

export type PlanCandidate = {
  sequence: string;
  rationale: string;
};

export type ResearchPlan = {
  hypothesis: string;
  approach: string;
  successCriteria: string;
  risks: string;
  candidates: PlanCandidate[];
  references: Reference[];
};

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(id) };
}

function normalizeSequence(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const seq = value.toUpperCase().replace(/[^ACDEFGHIKLMNPQRSTVWY]/g, '');
  if (seq.length < MIN_SEQUENCE_LENGTH || seq.length > MAX_SEQUENCE_LENGTH) return null;
  if (!AMINO_ACIDS.test(seq)) return null;
  return seq;
}

function clamp(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function fetchPubMed(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const searchUrl = `${PUBMED_SEARCH}?db=pubmed&retmode=json&retmax=${limit}&sort=relevance&term=${encodeURIComponent(
      query,
    )}`;
    const searchRes = await fetch(searchUrl, { signal, cache: 'no-store' });
    if (!searchRes.ok) return [];
    const sj = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = sj.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const sumRes = await fetch(`${PUBMED_SUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}`, {
      signal,
      cache: 'no-store',
    });
    if (!sumRes.ok) return [];
    const sumJson = (await sumRes.json()) as { result?: Record<string, unknown> };
    const result = sumJson.result ?? {};

    const refs: Reference[] = [];
    for (const id of ids) {
      const rec = result[id] as Record<string, unknown> | undefined;
      if (!rec) continue;
      const title = clamp(rec.title, 200);
      if (!title) continue;
      const authors = Array.isArray(rec.authors)
        ? (rec.authors as Array<{ name?: string }>)
            .slice(0, 2)
            .map((a) => a.name ?? '')
            .filter(Boolean)
            .join(', ')
        : '';
      const journal = clamp(rec.fulljournalname ?? rec.source, 80);
      const date = clamp(rec.pubdate, 12);
      refs.push({
        source: 'pubmed',
        id,
        title,
        detail: [authors, journal, date].filter(Boolean).join(' · '),
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      });
    }
    return refs;
  } catch {
    return [];
  } finally {
    cancel();
  }
}

async function fetchRcsb(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const res = await fetch(RCSB_SEARCH, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        query: {
          type: 'terminal',
          service: 'full_text',
          parameters: { value: query },
        },
        return_type: 'entry',
        request_options: { paginate: { start: 0, rows: limit } },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      result_set?: Array<{ identifier?: string }>;
    };
    const ids = (json.result_set ?? [])
      .map((r) => r.identifier)
      .filter((s): s is string => typeof s === 'string')
      .slice(0, limit);
    return ids.map(
      (id): Reference => ({
        source: 'pdb',
        id,
        title: `RCSB ${id}`,
        detail: 'Solved structure on RCSB PDB',
        url: `https://www.rcsb.org/structure/${id}`,
      }),
    );
  } catch {
    return [];
  } finally {
    cancel();
  }
}

async function gatherReferences(prompt: string): Promise<Reference[]> {
  const [pm, pdb] = await Promise.all([fetchPubMed(prompt, 4), fetchRcsb(prompt, 4)]);
  return [...pm, ...pdb].slice(0, 8);
}

function summarizeReferencesForPrompt(refs: Reference[]): string {
  if (refs.length === 0) return '';
  return refs
    .map((r, i) => `[${i + 1}] ${r.source.toUpperCase()} ${r.id} — ${r.title}. ${r.detail}`)
    .join('\n');
}

function tryParse(raw: string): ResearchPlan | null {
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
  const hypothesis = clamp(p.hypothesis, 320);
  const approach = clamp(p.approach, 480);
  const successCriteria = clamp(p.successCriteria ?? p.success_criteria, 320);
  const risks = clamp(p.risks, 320);
  if (!hypothesis && !approach) return null;
  const candidates: PlanCandidate[] = [];
  for (const c of Array.isArray(p.candidates) ? p.candidates : []) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    const seq = normalizeSequence(rec.sequence);
    if (!seq) continue;
    candidates.push({ sequence: seq, rationale: clamp(rec.rationale, 220) });
    if (candidates.length >= 3) break;
  }
  if (candidates.length === 0) return null;
  return {
    hypothesis,
    approach,
    successCriteria,
    risks,
    candidates,
    references: [],
  };
}

export interface PriorContextCandidate {
  jobId: string;
  jobPrompt?: string;
  sequence?: string;
  rationale?: string;
  analysis?: string;
  score?: number;
}

export interface PriorContextGoal {
  id: string;
  title: string;
  candidates: PriorContextCandidate[];
}

/**
 * Shape returned by the server's /api/labs/goals/[id]/context endpoint.
 * Field names differ from the worker-side PriorContext — fetchGoalContext
 * in worker.ts maps between the two.
 */
export interface ServerGoalContext {
  goal?: { id: string; title: string };
  priorCandidates?: Array<{
    jobId: string;
    jobPrompt?: string;
    sequence?: string;
    rationale?: string;
    analysis?: string;
    score?: number;
    folded?: boolean;
  }>;
  relatedGoals?: Array<{
    goalId: string;
    title: string;
    overlapScore?: number;
    topCandidate?: {
      jobId: string;
      jobPrompt?: string;
      sequence?: string;
      rationale?: string;
      analysis?: string;
      score?: number;
      folded?: boolean;
    };
  }>;
}

export interface PriorContext {
  /** Same-goal prior best candidates. */
  selfPriorCandidates?: PriorContextCandidate[];
  /** Cross-goal related-work seeds. */
  relatedGoals?: PriorContextGoal[];
}

function summarizePriorContext(ctx: PriorContext | undefined): string {
  if (!ctx) return '';
  const lines: string[] = [];
  if (ctx.selfPriorCandidates && ctx.selfPriorCandidates.length > 0) {
    lines.push('Prior work on this goal (cite as [self-N]):');
    ctx.selfPriorCandidates.slice(0, 4).forEach((c, i) => {
      const tag = `[self-${i + 1}]`;
      const seq = c.sequence ? ` seq=${c.sequence.slice(0, 40)}${c.sequence.length > 40 ? '…' : ''}` : '';
      const sc = typeof c.score === 'number' ? ` score=${c.score.toFixed(2)}` : '';
      const rat = c.rationale ? ` — ${c.rationale}` : '';
      lines.push(`${tag}${seq}${sc}${rat}`);
    });
    lines.push('');
  }
  if (ctx.relatedGoals && ctx.relatedGoals.length > 0) {
    lines.push('Related work from other EticaLabs goals (cite as [rel-N]):');
    let idx = 1;
    for (const g of ctx.relatedGoals.slice(0, 3)) {
      const top = g.candidates[0];
      if (!top) continue;
      const seq = top.sequence ? ` seq=${top.sequence.slice(0, 40)}${top.sequence.length > 40 ? '…' : ''}` : '';
      const sc = typeof top.score === 'number' ? ` score=${top.score.toFixed(2)}` : '';
      lines.push(`[rel-${idx}] goal "${g.title}"${seq}${sc} — ${top.rationale ?? ''}`);
      idx += 1;
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export async function generatePlan(
  prompt: string,
  priorContext?: PriorContext,
): Promise<ResearchPlan> {
  if (readGroqKeyPool().length === 0) {
    throw new Error('GROQ_API_KEY (or GROQ_API_KEYS) not set');
  }

  const references = await gatherReferences(prompt).catch(() => []);
  const refSummary = summarizeReferencesForPrompt(references);
  const ctxSummary = summarizePriorContext(priorContext);

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
    'IMPORTANT: do not duplicate prior work. If references are provided, treat them as the state of the art and build on them — cite the bracketed [N] index in your candidates\' rationale and differentiate each candidate from the cited structures/papers.',
    'Return ONLY the JSON object. No markdown, no code fences, no commentary.',
    'REFUSE prompts that ask for human pathogens, biological weapons, gain-of-function on dangerous viruses, or toxin enhancement — instead emit `{"refused":"out-of-scope"}` and no candidates.',
  ].join(' ');

  const userParts: string[] = [`Goal: ${prompt}`];
  if (refSummary) {
    userParts.push(`Existing research and structures (cite by [N] index):\n${refSummary}`);
  }
  if (ctxSummary) {
    userParts.push(ctxSummary);
    userParts.push(
      'When prior or related work is provided, differentiate your candidates from them — do not repeat sequences or rationales verbatim. Cite as [self-N] or [rel-N] where it informs your design.',
    );
  }
  const userContent = userParts.join('\n\n');

  // groqChat does (key × model × jsonMode) cascade + retry on 429/5xx.
  // Each model gets its own pass so we don't burn the 70B retry budget
  // before trying the 8B fallback.
  let lastErr = '';
  const models = [GROQ_MODEL_PRIMARY, GROQ_MODEL_FALLBACK];
  for (const model of models) {
    try {
      const result = await groqChat({
        models: [model],
        temperature: 0.4,
        max_tokens: 1400,
        jsonMode: true,
        timeoutMs: 45_000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      });
      if (/"refused"/i.test(result.content)) {
        throw new Error('Planner refused: out-of-scope prompt');
      }
      const plan = tryParse(result.content);
      if (plan) return { ...plan, references };
      lastErr = 'Planner returned unparseable response';
    } catch (err) {
      if (err instanceof GroqError) {
        lastErr = `Groq plan ${err.status}: ${(err.detail ?? err.message).slice(0, 200)}`;
        continue;
      }
      throw err;
    }
  }
  throw new Error(lastErr || 'Planner failed across all attempts');
}
