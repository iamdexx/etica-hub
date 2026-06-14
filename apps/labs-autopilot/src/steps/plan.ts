/**
 * Worker-side research plan generation. Mirrors the prompt + JSON schema
 * of `/api/labs/plan` but runs from the GitHub Actions worker against
 * Nvidia Nemotron 550B + academic APIs (PubMed, RCSB PDB, UniProt,
 * ChEMBL, STRING, KEGG) directly.
 *
 * Why duplicate the Vercel route: the worker doesn't go through Vercel,
 * so it cannot inherit the route's secrets. Keeping a thin worker-side
 * copy keeps the autopilot independent of any Next.js bundling.
 */

import {
  nvidiaChat,
  NvidiaLLMError,
  NVIDIA_MODEL_PRIMARY,
  NVIDIA_MODEL_FALLBACK,
  hasLLMProxy,
} from '../nvidia';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const RCSB_SEARCH = 'https://search.rcsb.org/rcsbsearch/v2/query';
const UNIPROT_SEARCH = 'https://rest.uniprot.org/uniprotkb/search';
const CHEMBL_SEARCH = 'https://www.ebi.ac.uk/chembl/api/data/target/search.json';
const STRING_API = 'https://string-db.org/api/json';
const KEGG_FIND = 'https://rest.kegg.jp/find/pathway';

/** Polite User-Agent per academic API fair-use policies. */
const UA = 'EticaHub-Labs/1.0 (https://eticahub.com; research-pipeline)';

/** fetch() wrapper that always includes the polite User-Agent header. */
function politeGet(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  headers.set('User-Agent', UA);
  return fetch(url, { ...opts, headers });
}
function politePost(url: string, body: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  headers.set('User-Agent', UA);
  headers.set('content-type', 'application/json');
  return fetch(url, { ...opts, method: 'POST', headers, body });
}

const AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const MAX_SEQUENCE_LENGTH = 400;
const MIN_SEQUENCE_LENGTH = 10;

export type ReferenceSource =
  | 'pubmed'
  | 'pdb'
  | 'uniprot'
  | 'chembl'
  | 'string'
  | 'kegg';

export type Reference = {
  source: ReferenceSource;
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

/** Retry a fetcher once with 2s backoff on failure. No silent skips. */
async function withRetry(fn: () => Promise<Reference[]>): Promise<Reference[]> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      return await fn();
    } catch {
      return [];
    }
  }
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
    const searchRes = await politeGet(searchUrl, { signal, cache: 'no-store' });
    if (!searchRes.ok) return [];
    const sj = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = sj.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const sumRes = await politeGet(`${PUBMED_SUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}`, {
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
    const res = await politePost(
      RCSB_SEARCH,
      JSON.stringify({
        query: {
          type: 'terminal',
          service: 'full_text',
          parameters: { value: query },
        },
        return_type: 'entry',
        request_options: { paginate: { start: 0, rows: limit } },
      }),
      { signal, cache: 'no-store' },
    );
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

async function fetchUniProt(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const url = `${UNIPROT_SEARCH}?query=${encodeURIComponent(query)}&format=json&size=${limit}&fields=accession,protein_name,organism_name,gene_names`;
    const res = await politeGet(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      results?: Array<{
        primaryAccession?: string;
        proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
        organism?: { scientificName?: string };
        genes?: Array<{ geneName?: { value?: string } }>;
      }>;
    };
    return (json.results ?? []).map((entry) => {
      const acc = entry.primaryAccession ?? '';
      const name = entry.proteinDescription?.recommendedName?.fullName?.value ?? `UniProt ${acc}`;
      const org = entry.organism?.scientificName ?? '';
      const gene = entry.genes?.[0]?.geneName?.value ?? '';
      return {
        source: 'uniprot' as const,
        id: acc,
        title: name,
        detail: [gene, org].filter(Boolean).join(' · '),
        url: `https://www.uniprot.org/uniprot/${acc}`,
      };
    });
  } catch {
    return [];
  } finally {
    cancel();
  }
}

async function fetchChEMBL(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const url = `${CHEMBL_SEARCH}?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await politeGet(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      targets?: Array<{
        target_chembl_id?: string;
        pref_name?: string;
        organism?: string;
        target_type?: string;
      }>;
    };
    return (json.targets ?? []).map((t) => {
      const id = t.target_chembl_id ?? '';
      return {
        source: 'chembl' as const,
        id,
        title: t.pref_name ?? `ChEMBL ${id}`,
        detail: [t.target_type, t.organism].filter(Boolean).join(' · '),
        url: `https://www.ebi.ac.uk/chembl/target_report_card/${id}/`,
      };
    });
  } catch {
    return [];
  } finally {
    cancel();
  }
}

async function fetchSTRING(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const url = `${STRING_API}/network?identifiers=${encodeURIComponent(query)}&species=9606&limit=${limit}&caller_identity=eticahub`;
    const res = await politeGet(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const interactions = (await res.json()) as Array<{
      preferredName_A?: string;
      preferredName_B?: string;
      score?: number;
    }>;
    const seen = new Set<string>();
    const refs: Reference[] = [];
    for (const i of interactions) {
      const partner = i.preferredName_B ?? '';
      if (!partner || seen.has(partner)) continue;
      seen.add(partner);
      refs.push({
        source: 'string',
        id: partner,
        title: `${i.preferredName_A ?? query} ↔ ${partner}`,
        detail: i.score ? `confidence=${(i.score / 1000).toFixed(2)}` : '',
        url: `https://string-db.org/cgi/network?identifiers=${encodeURIComponent(query)}&species=9606`,
      });
      if (refs.length >= limit) break;
    }
    return refs;
  } catch {
    return [];
  } finally {
    cancel();
  }
}

async function fetchKEGG(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const url = `${KEGG_FIND}/${encodeURIComponent(query)}`;
    const res = await politeGet(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const text = await res.text();
    return text
      .trim()
      .split('\n')
      .slice(0, limit)
      .map((line) => {
        const [pathId, ...rest] = line.split('\t');
        const title = rest.join(' ').trim();
        const id = (pathId ?? '').replace('path:', '');
        return {
          source: 'kegg' as const,
          id,
          title: title || `KEGG ${id}`,
          detail: 'Pathway',
          url: `https://www.kegg.jp/pathway/${id}`,
        };
      });
  } catch {
    return [];
  } finally {
    cancel();
  }
}

async function gatherReferences(prompt: string): Promise<Reference[]> {
  const [pm, pdb, uniprot, chembl, interactions, pathways] = await Promise.all([
    withRetry(() => fetchPubMed(prompt, 4)),
    withRetry(() => fetchRcsb(prompt, 3)),
    withRetry(() => fetchUniProt(prompt, 2)),
    withRetry(() => fetchChEMBL(prompt, 2)),
    withRetry(() => fetchSTRING(prompt, 3)),
    withRetry(() => fetchKEGG(prompt, 2)),
  ]);
  return [...pm, ...pdb, ...uniprot, ...chembl, ...interactions, ...pathways].slice(0, 16);
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
  if (!hasLLMProxy()) {
    throw new Error('LABS_AUTOPILOT_TOKEN not set — cannot reach LLM proxy');
  }

  const references = await gatherReferences(prompt).catch(() => []);
  const refSummary = summarizeReferencesForPrompt(references);
  const ctxSummary = summarizePriorContext(priorContext);

  // Disable Nemotron's verbose chain-of-thought — without this the 550B
  // model rambles to the token cap (~1400 tok / 130s) and the call times
  // out. With it off + the terseness rules below it stops at ~650 tok/55s.
  // Must be on its own line for the model to recognise the directive.
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
    'IMPORTANT: do not duplicate prior work. If references are provided, treat them as the state of the art and build on them — cite the bracketed [N] index in your candidates\' rationale and differentiate each candidate from the cited structures/papers.',
    'PATENT SAFETY: Design NOVEL sequences only. ChEMBL references represent EXISTING patented or published therapeutics — you MUST differentiate your candidates from them by at least 20% sequence divergence. Never reproduce or closely mimic known drug sequences. Each candidate must be a genuinely novel design, not a copy of existing IP. If a ChEMBL target is referenced, use it as inspiration for the binding mechanism but design an original sequence with different residues.',
    'Return ONLY the JSON object. No markdown, no code fences, no commentary.',
    'BE TERSE: every text field must be a single short clause; rationales under 18 words. Output minified JSON and stop immediately after the closing brace — do not keep writing.',
    'REFUSE prompts that ask for human pathogens, biological weapons, gain-of-function on dangerous viruses, or toxin enhancement — instead emit `{"refused":"out-of-scope"}` and no candidates.',
  ].join(' ');

  const userParts: string[] = [`Goal: ${prompt}`];
  if (refSummary) {
    userParts.push(
      `Academic references (PubMed literature, PDB structures, UniProt proteins, ChEMBL bioactivity, STRING interactions, KEGG pathways). Cite by [N] index:\n${refSummary}`,
    );
  }
  if (ctxSummary) {
    userParts.push(ctxSummary);
    userParts.push(
      'When prior or related work is provided, differentiate your candidates from them — do not repeat sequences or rationales verbatim. Cite as [self-N] or [rel-N] where it informs your design.',
    );
  }
  const userContent = userParts.join('\n\n');

  // nvidiaChat does (key × model × jsonMode) cascade + retry on 429/5xx.
  let lastErr = '';
  const models = [NVIDIA_MODEL_PRIMARY, NVIDIA_MODEL_FALLBACK];
  for (const model of models) {
    try {
      const result = await nvidiaChat({
        models: [model],
        temperature: 0.4,
        // Ceiling, not a target: 'detailed thinking off' + the terse schema
        // make 550B stop at ~650 tok. 1400 only guards against truncating a
        // valid plan with three long (≤400-residue) sequences.
        max_tokens: 1400,
        jsonMode: true,
        // 550B plan latency is highly variable in production (measured
        // ~60s up to ~170s under load). The Vercel proxy runs on the Pro
        // plan (300s ceiling), so we give a single call 240s — enough to
        // finish on the first attempt at the high end instead of aborting
        // at 150s and burning a retry (which wastes the 40 RPM budget).
        timeoutMs: 240_000,
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
      if (err instanceof NvidiaLLMError) {
        lastErr = `Nvidia plan ${err.status}: ${(err.detail ?? err.message).slice(0, 200)}`;
        continue;
      }
      throw err;
    }
  }
  throw new Error(lastErr || 'Planner failed across all attempts');
}
