/**
 * Worker-only endpoint: generate an auto-seed research prompt server-side.
 *
 * The Nvidia LLM API is unreachable from GitHub Actions runners but works
 * fine from Vercel's edge. This endpoint moves the seed LLM call to
 * server-side so the worker can reliably get a seed prompt.
 *
 * POST /api/labs/seed
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   returns: { ok: true, prompt, topic, title?, campaign?, source, paperTitles }
 *          | { ok: false, error }
 *
 * Seeding is campaign-weighted (see lib/labs/campaign.ts): most auto-seeds
 * are drawn from the active priority disease area, the rest from the general
 * biomedical pool.
 */

import { NextRequest } from 'next/server';

import { drawCampaign, type Campaign } from '@/lib/labs/campaign';
import { nvidiaChat, hasNvidiaKey, NvidiaError, NVIDIA_MODEL_PRIMARY } from '@/lib/labs/nvidia';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// PubMed/UniProt prefetch (up to ~15s each) runs before the 550B seed call,
// which itself can take up to 60s with retries; 300s (Pro plan) keeps the
// whole request inside the function wall.
export const maxDuration = 300;

const UA = 'EticaHub-Labs/1.0 (https://eticahub.com; research-pipeline)';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const UNIPROT_SEARCH = 'https://rest.uniprot.org/uniprotkb/search';

const TOPIC_POOL = [
  'novel peptide inhibitor design',
  'protein structure drug target',
  'CRISPR gene therapy clinical',
  'mRNA vaccine novel antigen',
  'cancer immunotherapy checkpoint',
  'neurodegenerative protein aggregation',
  'antimicrobial resistance peptide',
  'rare disease enzyme replacement',
  'protein-protein interaction inhibitor',
  'allosteric modulator structure',
  'CAR-T cell engineering',
  'targeted protein degradation PROTAC',
  'antibody drug conjugate',
  'epigenetic therapy histone',
  'metabolic disease enzyme target',
  'autoimmune disorder biological therapy',
  'cardiovascular peptide therapeutic',
  'inflammation cytokine blocker',
  'viral protease inhibitor structure',
  'receptor tyrosine kinase inhibitor',
  'nanobody single domain antibody',
  'RNA aptamer therapeutic',
  'mitochondrial disease therapy',
  'gut microbiome peptide',
  'pain management ion channel',
  'fibrosis antifibrotic target',
  'senolytic senescence therapy',
  'circadian rhythm drug metabolism',
  'exosome drug delivery',
  'organoid disease model',
];

/**
 * Curated, patent-safe seeds used only when 550B cannot produce a valid
 * prompt (auth/quota outage, persistent meta-commentary). Keeps the
 * discovery cascade alive; the response is tagged `source: 'fallback'`.
 */
const FALLBACK_SEEDS = [
  'Design a cyclic peptide inhibitor targeting the PD-1/PD-L1 interface for melanoma immunotherapy',
  'Engineer a thermostable variant of human lysozyme with enhanced antimicrobial activity against MRSA',
  'Develop a stapled alpha-helical peptide blocking the MDM2-p53 interaction for glioblastoma treatment',
  'Design a beta-hairpin peptide that disrupts amyloid-beta oligomerisation for early Alzheimer\'s disease',
  'Engineer a nanobody scaffold binding the SARS-CoV-2 spike RBD with cross-variant neutralisation',
  'Design a mitochondria-targeted peptide that stabilises complex I assembly for Leigh syndrome',
  'Develop a KRAS-G12D selective helical peptide occupying the switch II pocket for pancreatic cancer',
  'Engineer an IL-17A blocking peptide with improved serum stability for psoriasis therapy',
  'Design a TDP-43 aggregation-inhibiting peptide for amyotrophic lateral sclerosis',
  'Develop a GLP-1 receptor agonist peptide with extended half-life for type 2 diabetes',
  'Design a cationic antimicrobial peptide selective for Pseudomonas aeruginosa biofilms',
  'Engineer a TGF-beta receptor II decoy peptide to attenuate idiopathic pulmonary fibrosis',
];

function fallbackSeedResponse(reason: string, campaign: Campaign | null): Response {
  console.error('[labs/seed] LLM seed failed, using fallback', { reason, campaign: campaign?.id });
  const pool = campaign ? campaign.seeds : FALLBACK_SEEDS;
  return Response.json({
    ok: true,
    prompt: pool[Math.floor(Math.random() * pool.length)]!,
    topic: campaign ? campaign.label : 'curated fallback',
    title: campaign ? `${campaign.disease} — driver-directed design` : undefined,
    source: 'fallback',
    campaign: campaign?.id,
    paperTitles: [],
    warning: `LLM seed failed: ${reason.slice(0, 300)}`,
  });
}

// 550B only — per product requirement, no smaller-model fallbacks. Nvidia
// is reachable from Vercel (unlike the GH Actions worker), so 550B answers
// reliably here.
const SEED_MODELS = [NVIDIA_MODEL_PRIMARY] as const;

function randomTopic(campaign: Campaign | null): string {
  const pool = campaign ? campaign.topics : TOPIC_POOL;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

function politeGet(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  headers.set('User-Agent', UA);
  return fetch(url, { ...opts, headers });
}

type PaperSummary = { id: string; title: string; authors: string; journal: string; date: string };

async function fetchRecentPapers(topic: string, count: number = 5): Promise<PaperSummary[]> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const retstart = Math.floor(Math.random() * 10);
    const searchUrl = `${PUBMED_SEARCH}?db=pubmed&retmode=json&retmax=${count}&retstart=${retstart}&sort=relevance&term=${encodeURIComponent(topic)}&_t=${Date.now()}`;
    const searchRes = await politeGet(searchUrl, { signal: ctrl.signal });
    if (!searchRes.ok) return [];
    const sj = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = sj.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const sumRes = await politeGet(`${PUBMED_SUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}&_t=${Date.now()}`, { signal: ctrl.signal });
    if (!sumRes.ok) return [];
    const sumJson = (await sumRes.json()) as { result?: Record<string, unknown> };
    const result = sumJson.result ?? {};

    const papers: PaperSummary[] = [];
    for (const id of ids) {
      const rec = result[id] as Record<string, unknown> | undefined;
      if (!rec) continue;
      const title = typeof rec.title === 'string' ? rec.title.trim() : '';
      if (!title) continue;
      const authors = Array.isArray(rec.authors)
        ? (rec.authors as Array<{ name?: string }>).slice(0, 3).map((a) => a.name ?? '').filter(Boolean).join(', ')
        : '';
      const journal = typeof rec.fulljournalname === 'string' ? rec.fulljournalname : typeof rec.source === 'string' ? rec.source : '';
      const date = typeof rec.pubdate === 'string' ? rec.pubdate : '';
      papers.push({ id, title, authors, journal, date });
    }
    return papers;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRandomProtein(): Promise<string | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const offset = Math.floor(Math.random() * 50);
    const url = `${UNIPROT_SEARCH}?query=reviewed:true+AND+organism_id:9606&format=json&size=1&offset=${offset}&fields=accession,protein_name,gene_names`;
    const res = await politeGet(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const entry = json.results?.[0];
    if (!entry) return null;
    const name =
      (entry.proteinDescription as Record<string, unknown>)?.recommendedName &&
      ((entry.proteinDescription as Record<string, unknown>).recommendedName as Record<string, unknown>)?.fullName
        ? (((entry.proteinDescription as Record<string, unknown>).recommendedName as Record<string, unknown>).fullName as Record<string, unknown>)?.value
        : null;
    const genes = Array.isArray(entry.genes)
      ? (entry.genes as Array<Record<string, unknown>>).map((g) => (g.geneName as Record<string, unknown>)?.value).filter(Boolean).join(', ')
      : '';
    if (name) return `${name}${genes ? ` (${genes})` : ''}`;
    if (genes) return genes;
    return (entry.primaryAccession as string) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The CDN in front of this route drops the connection around 100s, so the
 * worker sees an HTML error page instead of JSON. Everything below must
 * finish well inside that: context prefetch + bounded LLM attempts, then
 * the curated fallback.
 */
const SEED_DEADLINE_MS = 55_000;

export async function POST(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });

  // A campaign biases this seed toward a priority disease area; the rest of
  // the time the general pool keeps the archive broad.
  const campaign = drawCampaign();

  if (!hasNvidiaKey()) return fallbackSeedResponse('no NVIDIA_API_KEY configured', campaign);

  // Try up to 3 different topics
  let papers: PaperSummary[] = [];
  let protein: string | null = null;
  let topic = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    topic = randomTopic(campaign);
    [papers, protein] = await Promise.all([
      fetchRecentPapers(topic, 5),
      attempt === 0 && !campaign ? fetchRandomProtein() : Promise.resolve(protein),
    ]);
    if (papers.length > 0 || protein) break;
  }

  // Build context
  const contextParts: string[] = [];
  if (papers.length > 0) {
    contextParts.push('Recent PubMed papers:');
    for (const p of papers) {
      contextParts.push(`- "${p.title}" (${p.authors}, ${p.journal}, ${p.date})`);
    }
  }
  if (protein) {
    contextParts.push(`Random human protein of interest: ${protein}`);
  }

  // The 'detailed thinking off' directive is sent as its OWN system message
  // below — concatenated with other text 550B ignores it and narrates.
  const system = [
    'You output a single imperative research sentence. Nothing else.',
    'Rules: max 280 characters, must name a specific protein/target/disease,',
    'must be a novel design direction (not summary of the input), patent-safe.',
    'NEVER output meta-commentary like "The user wants" or "Here is a prompt".',
    'NEVER describe what the prompt should be. Just output the prompt itself.',
    ...(campaign ? ['', ...campaign.constraints] : []),
    '',
    'Examples of CORRECT output:',
    '- Design a cyclic peptide inhibitor targeting the PD-1/PD-L1 interface for melanoma immunotherapy',
    '- Engineer a thermostable variant of human lysozyme with enhanced antimicrobial activity against MRSA',
    '- Develop a stapled alpha-helical peptide blocking the MDM2-p53 interaction for glioblastoma treatment',
  ].join('\n');

  const user = [
    `Topic: ${topic}`,
    ...contextParts,
    '',
    'Output ONE imperative research sentence:',
  ].join('\n');

  // Try each model in cascade, retry up to 3 times if LLM echoes instructions
  const metaStart = /^(the user wants|here is|this prompt|a research prompt|generate a (new |novel )?(research )?prompt|the prompt|we need to output|we need to generate|i need to|output one|the topic|the goal)/i;
  const metaBody = /max 280 characters|imperative research sentence|naming a specific protein/i;

  let prompt = '';
  let succeeded = false;
  let lastFailure = '';

  for (let retry = 0; retry < 3 && !succeeded; retry++) {
    if (Date.now() - startedAt > SEED_DEADLINE_MS) {
      lastFailure = lastFailure || 'deadline exceeded before a valid prompt';
      break;
    }
    for (const model of SEED_MODELS) {
      try {
        const result = await nvidiaChat({
          models: [model],
          temperature: 0.7 + retry * 0.1, // increase randomness on retry
          max_tokens: 200,
          timeoutMs: 15_000,
          maxRetriesPerKey: 1,
          messages: [
            { role: 'system', content: 'detailed thinking off' },
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        });
        let candidate = result.content.trim();
        candidate = candidate.replace(/^["'`]+|["'`]+$/g, '').trim();
        candidate = candidate.replace(/^-\s+/, '').trim();
        candidate = candidate.split('\n')[0]?.trim() ?? '';
        if (candidate.length > 280) candidate = candidate.slice(0, 280).trim();
        if (candidate.length < 30) { lastFailure = `too short: ${JSON.stringify(candidate)}`; continue; }
        if (metaStart.test(candidate) || metaBody.test(candidate)) {
          lastFailure = `meta-commentary: ${JSON.stringify(candidate.slice(0, 120))}`;
          continue;
        }
        prompt = candidate;
        succeeded = true;
        break;
      } catch (err) {
        lastFailure =
          err instanceof NvidiaError
            ? `nvidia ${err.status}: ${err.detail ?? err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        continue;
      }
    }
  }

  if (!succeeded) return fallbackSeedResponse(`topic ${topic}: ${lastFailure}`, campaign);

  const source = papers.length > 0 && protein ? 'combined' : papers.length > 0 ? 'pubmed' : protein ? 'uniprot' : 'topic-only';

  return Response.json({
    ok: true,
    prompt,
    topic,
    // Goal titles of the form "<disease> — <topic>" let the archive index the
    // run under its disease facet instead of leaving it unlabelled.
    title: campaign ? `${campaign.disease} — ${topic}` : undefined,
    source,
    campaign: campaign?.id,
    paperTitles: papers.map((p) => p.title),
  });
}
