/**
 * Target grounding — does the protein a run claims to target actually exist?
 *
 * The planner is free to invent a target ("SMAD4-restoring peptide against
 * the XYZ1 pocket"). Verification of the design says nothing about that:
 * a plausible peptide aimed at a non-existent protein is still worthless.
 * This resolves stated targets against UniProt (reviewed/Swiss-Prot first)
 * and citations against PubMed, so an archived record can say which of its
 * claims correspond to real entities.
 *
 * "Grounded" means the target and the literature exist — never that the
 * design binds the target.
 */

const UNIPROT_SEARCH = 'https://rest.uniprot.org/uniprotkb/search';
const PUBMED_SUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const TIMEOUT_MS = 15_000;

/** Words that look like gene symbols but are domain vocabulary, not targets. */
const STOPWORDS = new Set([
  'AI',
  'ALS',
  'AND',
  'DNA',
  'FDA',
  'IPF',
  'MD',
  'NMR',
  'PDB',
  'PDAC',
  'RNA',
  'THE',
  'WITH',
  'DE',
  'NOVO',
  'IC50',
  'KD',
  'EC50',
  'ESM',
  'ESMFOLD',
  'MPNN',
  'PROTEINMPNN',
  'CRYO',
  'EM',
  'NGS',
  'PPI',
  'SAR',
  'PMID',
  'PMC',
  'DOI',
  'UNIPROT',
  'BLAST',
  'HTTP',
  'HTTPS',
  'WWW',
  'KEGG',
  'GEO',
  'BBB',
  'ITC',
  'SPR',
  'ELISA',
  'MST',
  'MRI',
  'PET',
  'CT',
  'ADME',
  'PK',
  'PKPD',
  'QSAR',
  'RMSD',
  'PLDDT',
  'PTM',
  'WT',
  'KO',
  'SIRNA',
  'MRNA',
  'CDNA',
  'CRISPR',
  'FRET',
  'SASA',
  'MHC',
  'IND',
  'NCCN',
]);

/** One-letter amino-acid alphabet, for spotting raw sequence text. */
const AA = 'ACDEFGHIKLMNPQRSTVWY';
/** A stretch this long of pure residue letters is a sequence, not prose. */
const SEQUENCE_RUN = new RegExp(`[${AA}]{15,}`, 'g');
/** `G12D`, `D835Y` — a substitution, not the gene it sits in. */
const MUTATION_CODE = new RegExp(`^[${AA}]\\d{1,4}[${AA}]$`);

/** A UniProt hit for a symbol the run claims to target. */
export interface TargetHit {
  /** The symbol as written in the prompt/goal. */
  symbol: string;
  accession: string;
  /** UniProt entry name, e.g. `KRAS_HUMAN`. */
  entryName: string;
  proteinName: string;
  /** True for Swiss-Prot (manually reviewed) entries. */
  reviewed: boolean;
  organism: string;
}

export interface GroundingResult {
  /** Symbols extracted from the text that resolved to a UniProt entry. */
  grounded: TargetHit[];
  /** Symbols that look like targets but resolved to nothing. */
  unresolved: string[];
  /** PubMed IDs cited by the run that exist. */
  citationsFound: string[];
  /** PubMed IDs cited by the run that do not exist. */
  citationsMissing: string[];
}

/**
 * Pull candidate gene/protein symbols out of free text.
 *
 * Deliberately conservative: uppercase tokens of 3–10 chars, optionally
 * with a digit or a mutation suffix (`KRAS`, `KRAS-G12D`, `CLDN18.2`,
 * `SMAD4`). Lowercase prose and long names are left to the curator.
 */
export function extractTargetSymbols(text: string): string[] {
  const out = new Set<string>();
  // Designed sequences are uppercase residue letters, so any window of one
  // reads as a symbol (`KLAVKLAD` -> `KLAV`). Skip matches inside them.
  const sequenceSpans: Array<[number, number]> = [];
  for (const run of text.matchAll(SEQUENCE_RUN)) {
    sequenceSpans.push([run.index!, run.index! + run[0].length]);
  }
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,9}(?:[.-][A-Z0-9]{1,6})?\b/g)) {
    const at = match.index!;
    if (sequenceSpans.some(([start, end]) => at >= start && at < end)) continue;
    // Drop the mutation/isoform suffix: KRAS-G12D targets the KRAS entry.
    const symbol = match[0].split(/[.-]/)[0]!;
    if (symbol.length < 3 || symbol.length > 10) continue;
    if (STOPWORDS.has(symbol)) continue;
    if (/^\d+$/.test(symbol)) continue;
    if (MUTATION_CODE.test(symbol)) continue;
    out.add(symbol);
  }
  return [...out];
}

interface UniProtResponse {
  results?: Array<{
    primaryAccession?: string;
    uniProtkbId?: string;
    entryType?: string;
    proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
    organism?: { scientificName?: string };
    genes?: Array<{ geneName?: { value?: string } }>;
  }>;
}

/**
 * The lookup itself failed, so nothing can be said about the claim. Kept
 * distinct from an empty result: "UniProt is down" must never be archived
 * as "this target does not exist".
 */
export class LookupUnavailableError extends Error {
  constructor(url: string, cause: string) {
    super(`lookup unavailable (${new URL(url).host}): ${cause}`);
    this.name = 'LookupUnavailableError';
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new LookupUnavailableError(url, `HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof LookupUnavailableError) throw err;
    throw new LookupUnavailableError(url, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one gene symbol to a human UniProt entry, preferring reviewed
 * entries and an exact gene-name match.
 */
export async function resolveTarget(symbol: string): Promise<TargetHit | null> {
  const query = encodeURIComponent(`gene:${symbol} AND organism_id:9606`);
  const url = `${UNIPROT_SEARCH}?query=${query}&fields=accession,id,protein_name,gene_names,organism_name,reviewed&size=5`;
  const data = await fetchJson<UniProtResponse>(url);
  const results = data.results ?? [];
  if (results.length === 0) return null;

  const exact = results.find((r) =>
    (r.genes ?? []).some((g) => g.geneName?.value?.toUpperCase() === symbol.toUpperCase()),
  );
  const reviewed = results.find((r) => r.entryType?.includes('Swiss-Prot'));
  const hit = exact ?? reviewed ?? results[0]!;
  if (!hit.primaryAccession) return null;
  return {
    symbol,
    accession: hit.primaryAccession,
    entryName: hit.uniProtkbId ?? hit.primaryAccession,
    proteinName: hit.proteinDescription?.recommendedName?.fullName?.value ?? '',
    reviewed: Boolean(hit.entryType?.includes('Swiss-Prot')),
    organism: hit.organism?.scientificName ?? '',
  };
}

/** PubMed IDs referenced anywhere in the run's text or reference list. */
export function extractPubmedIds(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/(?:pubmed(?:\.ncbi\.nlm\.nih\.gov)?\/|PMID:?\s*)(\d{5,8})/gi)) {
      out.add(m[1]!);
    }
  }
  return [...out];
}

interface PubmedSummary {
  result?: Record<string, { uid?: string; error?: string; title?: string }>;
}

/** Split cited PubMed IDs into those that exist and those that do not. */
export async function checkPubmedIds(
  ids: readonly string[],
): Promise<{ found: string[]; missing: string[] }> {
  if (ids.length === 0) return { found: [], missing: [] };
  const url = `${PUBMED_SUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}`;
  const data = await fetchJson<PubmedSummary>(url);
  if (!data.result) return { found: [], missing: [...ids] };
  const found: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const entry = data.result[id];
    if (entry && !entry.error && entry.title) found.push(id);
    else missing.push(id);
  }
  return { found, missing };
}

/**
 * Ground a run: resolve the targets it names and the papers it cites.
 *
 * `maxSymbols` bounds the UniProt calls — the planner's prose can mention
 * a dozen uppercase tokens and only the first few are the actual subject.
 */
export async function groundRun(
  texts: readonly string[],
  maxSymbols = 6,
): Promise<GroundingResult> {
  const symbols = extractTargetSymbols(texts.join(' ')).slice(0, maxSymbols);
  const hits = await Promise.all(symbols.map((s) => resolveTarget(s)));
  const grounded: TargetHit[] = [];
  const unresolved: string[] = [];
  hits.forEach((hit, i) => {
    if (hit) grounded.push(hit);
    else unresolved.push(symbols[i]!);
  });
  const { found, missing } = await checkPubmedIds(extractPubmedIds(texts));
  return { grounded, unresolved, citationsFound: found, citationsMissing: missing };
}

/** One-line human summary for archive records and the UI. */
export function groundingSummary(result: GroundingResult): string {
  const parts: string[] = [];
  if (result.grounded.length > 0) {
    parts.push(
      `targets resolved: ${result.grounded
        .map((h) => `${h.symbol} (${h.accession}${h.reviewed ? '' : ', unreviewed'})`)
        .join(', ')}`,
    );
  }
  if (result.unresolved.length > 0) {
    parts.push(`unresolved symbols: ${result.unresolved.join(', ')}`);
  }
  if (result.citationsFound.length > 0) {
    parts.push(`${result.citationsFound.length} citation(s) verified in PubMed`);
  }
  if (result.citationsMissing.length > 0) {
    parts.push(`${result.citationsMissing.length} cited PMID(s) not found`);
  }
  return parts.length > 0 ? parts.join('; ') : 'no named target or citation found';
}
