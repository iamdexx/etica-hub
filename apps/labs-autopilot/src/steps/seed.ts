/**
 * Auto-seeding module: fetches random/recent academic data from public
 * biomedical APIs to generate new research directions when the job
 * queue is empty. Ensures the autopilot never sits idle.
 *
 * Strategy:
 *   1. Pick a random biomedical topic category.
 *   2. Fetch recent papers from PubMed (sorted by recency, randomized page).
 *   3. Ask Nvidia Nemotron to distill a novel research prompt from the paper.
 *   4. Return the prompt for the worker to enqueue via /api/labs/queue/spawn.
 *
 * The seed prompt is always a narrow, actionable research direction —
 * never a broad topic like "cancer". This ensures the planner produces
 * high-quality candidates.
 */

import { nvidiaChat, NVIDIA_MODEL_PRIMARY, readNvidiaLLMKeyPool } from '../nvidia';

/** Polite User-Agent per academic API fair-use policies. */
const UA = 'EticaHub-Labs/1.0 (https://eticahub.com; research-pipeline)';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const UNIPROT_SEARCH = 'https://rest.uniprot.org/uniprotkb/search';

/**
 * Broad biomedical topic categories to sample from. Each entry is a
 * PubMed-friendly search term that returns recent, high-quality papers.
 */
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
 * Pick a random topic from the pool.
 */
function randomTopic(): string {
  return TOPIC_POOL[Math.floor(Math.random() * TOPIC_POOL.length)]!;
}

function politeGet(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  headers.set('User-Agent', UA);
  return fetch(url, { ...opts, headers });
}

type PaperSummary = {
  id: string;
  title: string;
  authors: string;
  journal: string;
  date: string;
};

/**
 * Fetch recent PubMed papers for a given topic. Uses a randomized
 * start offset so repeated calls get different papers.
 */
async function fetchRecentPapers(topic: string, count: number = 5): Promise<PaperSummary[]> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // Small random offset (0-9) to add variety while staying within result bounds
    const retstart = Math.floor(Math.random() * 10);
    const searchUrl = `${PUBMED_SEARCH}?db=pubmed&retmode=json&retmax=${count}&retstart=${retstart}&sort=relevance&term=${encodeURIComponent(
      topic,
    )}`;
    const searchRes = await politeGet(searchUrl, { signal: ctrl.signal, cache: 'no-store' });
    if (!searchRes.ok) return [];
    const sj = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = sj.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const sumRes = await politeGet(`${PUBMED_SUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
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
        ? (rec.authors as Array<{ name?: string }>)
            .slice(0, 3)
            .map((a) => a.name ?? '')
            .filter(Boolean)
            .join(', ')
        : '';
      const journal = typeof rec.fulljournalname === 'string'
        ? rec.fulljournalname
        : typeof rec.source === 'string'
          ? rec.source
          : '';
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

/**
 * Fetch a random reviewed protein from UniProt to use as a structural seed.
 */
async function fetchRandomProtein(): Promise<string | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // Random offset (0-50) — reviewed human proteome has ~20k entries, keep offset small for reliability
    const offset = Math.floor(Math.random() * 50);
    const url = `${UNIPROT_SEARCH}?query=reviewed:true+AND+organism_id:9606&format=json&size=1&offset=${offset}&fields=accession,protein_name,gene_names`;
    const res = await politeGet(url, { signal: ctrl.signal, cache: 'no-store' });
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
      ? (entry.genes as Array<Record<string, unknown>>)
          .map((g) => (g.geneName as Record<string, unknown>)?.value)
          .filter(Boolean)
          .join(', ')
      : '';
    if (name) return `${name}${genes ? ` (${genes})` : ''}`;
    if (genes) return genes;
    return entry.primaryAccession as string ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface SeedResult {
  prompt: string;
  topic: string;
  source: 'pubmed' | 'uniprot' | 'combined';
  paperTitles?: string[];
}

/**
 * Generate a novel research prompt by pulling random academic data and
 * asking Nvidia Nemotron to distill it into an actionable research direction.
 *
 * Returns null if seeding fails (no API responses, LLM unreachable).
 */
export async function generateSeedPrompt(): Promise<SeedResult | null> {
  if (readNvidiaLLMKeyPool().length === 0) return null;

  // Try up to 3 different topics if the first fetch fails
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

  if (papers.length === 0 && !protein) return null;

  // Build context for the LLM
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

  try {
    const result = await nvidiaChat({
      models: [NVIDIA_MODEL_PRIMARY],
      temperature: 0.7,
      max_tokens: 200,
      timeoutMs: 20_000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    let prompt = result.content.trim();
    // Strip surrounding quotes / backticks
    prompt = prompt.replace(/^["'`]+|["'`]+$/g, '').trim();
    // Strip leading "- " from examples format
    prompt = prompt.replace(/^-\s+/, '').trim();
    // Take first line only
    prompt = prompt.split('\n')[0]?.trim() ?? '';
    // Truncate to 280 chars
    if (prompt.length > 280) prompt = prompt.slice(0, 280).trim();
    // Reject if too short (likely a refusal or junk)
    if (prompt.length < 30) return null;
    // Reject meta-descriptions (LLM echoing instructions instead of following them)
    const metaPatterns = /^(the user wants|here is|this prompt|a research prompt|generate a|the prompt)/i;
    if (metaPatterns.test(prompt)) return null;

    return {
      prompt,
      topic,
      source: papers.length > 0 && protein ? 'combined' : papers.length > 0 ? 'pubmed' : 'uniprot',
      paperTitles: papers.map((p) => p.title),
    };
  } catch {
    return null;
  }
}
