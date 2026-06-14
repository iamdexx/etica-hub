/**
 * Worker-only endpoint: generate an auto-seed research prompt server-side.
 *
 * The Nvidia LLM API is unreachable from GitHub Actions runners but works
 * fine from Vercel's edge. This endpoint moves the seed LLM call to
 * server-side so the worker can reliably get a seed prompt.
 *
 * POST /api/labs/seed
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   returns: { ok: true, prompt, topic, source, paperTitles } | { ok: false, error }
 */

import { NextRequest } from 'next/server';

import { nvidiaChat, hasNvidiaKey, NVIDIA_MODEL_PRIMARY } from '@/lib/labs/nvidia';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

// 550B only — per product requirement, no smaller-model fallbacks.
const SEED_MODELS = [NVIDIA_MODEL_PRIMARY] as const;

function randomTopic(): string {
  return TOPIC_POOL[Math.floor(Math.random() * TOPIC_POOL.length)]!;
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

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });

  if (!hasNvidiaKey()) {
    return Response.json({ ok: false, error: 'No NVIDIA_API_KEY configured' }, { status: 500 });
  }

  // Try up to 3 different topics
  let papers: PaperSummary[] = [];
  let protein: string | null = null;
  let topic = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    topic = randomTopic();
    [papers, protein] = await Promise.all([
      fetchRecentPapers(topic, 5),
      attempt === 0 ? fetchRandomProtein() : Promise.resolve(protein),
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

  const system = [
    'detailed thinking off',
    'You output a single imperative research sentence. Nothing else.',
    'Rules: max 280 characters, must name a specific protein/target/disease,',
    'must be a novel design direction (not summary of the input), patent-safe.',
    'NEVER output meta-commentary like "The user wants" or "Here is a prompt".',
    'NEVER describe what the prompt should be. Just output the prompt itself.',
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

  for (let retry = 0; retry < 3 && !succeeded; retry++) {
    for (const model of SEED_MODELS) {
      try {
        const result = await nvidiaChat({
          models: [model],
          temperature: 0.7 + retry * 0.1, // increase randomness on retry
          max_tokens: 200,
          timeoutMs: 60_000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        });
        let candidate = result.content.trim();
        candidate = candidate.replace(/^["'`]+|["'`]+$/g, '').trim();
        candidate = candidate.replace(/^-\s+/, '').trim();
        candidate = candidate.split('\n')[0]?.trim() ?? '';
        if (candidate.length > 280) candidate = candidate.slice(0, 280).trim();
        if (candidate.length < 30) continue;
        if (metaStart.test(candidate)) continue;
        if (metaBody.test(candidate)) continue;
        prompt = candidate;
        succeeded = true;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!succeeded) {
    return Response.json({ ok: false, error: 'LLM failed to produce a valid research prompt after retries' }, { status: 422 });
  }

  const source = papers.length > 0 && protein ? 'combined' : papers.length > 0 ? 'pubmed' : protein ? 'uniprot' : 'topic-only';

  return Response.json({
    ok: true,
    prompt,
    topic,
    source,
    paperTitles: papers.map((p) => p.title),
  });
}
