/**
 * Research aggregation helpers for the Labs planner.
 *
 * Pulls related data from multiple free academic APIs:
 *   - PubMed (NCBI/NIH) — peer-reviewed literature
 *   - RCSB PDB (Rutgers/UCSD/UCSF) — experimental 3D structures
 *   - UniProt (EMBL-EBI/SIB/PIR) — protein sequences, domains, PTMs
 *   - ChEMBL (EMBL-EBI) — bioactivity data, IC50/Ki, SAR
 *   - AlphaFold DB (EMBL-EBI/DeepMind) — predicted structures
 *   - STRING (UniZurich/EMBL) — protein-protein interactions
 *   - KEGG (Kyoto University) — pathway mappings
 *
 * All APIs are free, public, and require no authentication — they're
 * rate-limited by IP. We hit them server-side with short timeouts so a
 * slow/down API never blocks the planner; in that case we return an
 * empty list and let the planner proceed without context.
 */

export type ReferenceSource =
  | 'pubmed'
  | 'pdb'
  | 'uniprot'
  | 'chembl'
  | 'alphafold'
  | 'string'
  | 'kegg';

export type Reference = {
  source: ReferenceSource;
  id: string;
  title: string;
  detail: string;
  url: string;
};

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const RCSB_SEARCH = 'https://search.rcsb.org/rcsbsearch/v2/query';

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

async function fetchPubMed(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(4_000);
  try {
    const searchUrl = `${PUBMED_SEARCH}?db=pubmed&retmode=json&retmax=${limit}&sort=relevance&term=${encodeURIComponent(
      query,
    )}`;
    const searchRes = await fetch(searchUrl, { signal, cache: 'no-store' });
    if (!searchRes.ok) return [];
    const searchJson = (await searchRes.json()) as {
      esearchresult?: { idlist?: string[] };
    };
    const ids = searchJson.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const summaryUrl = `${PUBMED_SUMMARY}?db=pubmed&retmode=json&id=${ids.join(',')}`;
    const summaryRes = await fetch(summaryUrl, { signal, cache: 'no-store' });
    if (!summaryRes.ok) return [];
    const summaryJson = (await summaryRes.json()) as {
      result?: Record<string, unknown>;
    };
    const result = summaryJson.result ?? {};

    const refs: Reference[] = [];
    for (const id of ids) {
      const entry = result[id] as
        | {
            title?: string;
            pubdate?: string;
            authors?: Array<{ name?: string }>;
            source?: string;
          }
        | undefined;
      if (!entry) continue;
      const authors = (entry.authors ?? [])
        .map((a) => a.name ?? '')
        .filter(Boolean)
        .slice(0, 3)
        .join(', ');
      const year = entry.pubdate?.slice(0, 4) ?? '';
      const journal = entry.source ?? '';
      const detailParts = [authors, year, journal].filter(Boolean);
      refs.push({
        source: 'pubmed',
        id,
        title: entry.title?.replace(/\.$/, '') ?? `PubMed ${id}`,
        detail: detailParts.join(' · '),
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

async function fetchPdb(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(4_000);
  try {
    const body = {
      query: {
        type: 'terminal',
        service: 'full_text',
        parameters: { value: query },
      },
      request_options: {
        paginate: { start: 0, rows: limit },
        sort: [{ sort_by: 'score', direction: 'desc' }],
        results_content_type: ['experimental'],
      },
      return_type: 'entry',
    };
    const res = await fetch(RCSB_SEARCH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      result_set?: Array<{ identifier?: string }>;
    };
    const ids = (json.result_set ?? [])
      .map((r) => r.identifier ?? '')
      .filter(Boolean)
      .slice(0, limit);
    if (ids.length === 0) return [];

    const refs: Reference[] = [];
    for (const id of ids) {
      try {
        const entryRes = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${id}`, {
          signal,
          cache: 'no-store',
        });
        if (!entryRes.ok) {
          refs.push({
            source: 'pdb',
            id,
            title: `PDB entry ${id}`,
            detail: '',
            url: `https://www.rcsb.org/structure/${id}`,
          });
          continue;
        }
        const entry = (await entryRes.json()) as {
          struct?: { title?: string };
          rcsb_accession_info?: { initial_release_date?: string };
          rcsb_primary_citation?: { rcsb_authors?: string[] };
        };
        const title = entry.struct?.title ?? `PDB entry ${id}`;
        const date = entry.rcsb_accession_info?.initial_release_date?.slice(0, 4) ?? '';
        const authors = (entry.rcsb_primary_citation?.rcsb_authors ?? []).slice(0, 3).join(', ');
        const detailParts = [authors, date].filter(Boolean);
        refs.push({
          source: 'pdb',
          id,
          title: title.replace(/\.$/, ''),
          detail: detailParts.join(' · '),
          url: `https://www.rcsb.org/structure/${id}`,
        });
      } catch {
        refs.push({
          source: 'pdb',
          id,
          title: `PDB entry ${id}`,
          detail: '',
          url: `https://www.rcsb.org/structure/${id}`,
        });
      }
    }
    return refs;
  } catch {
    return [];
  } finally {
    cancel();
  }
}

// ─── UniProt (EMBL-EBI / SIB / PIR) ─────────────────────────────────────────
// Protein sequences, domains, PTMs, functional annotations.

const UNIPROT_SEARCH = 'https://rest.uniprot.org/uniprotkb/search';

async function fetchUniProt(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const url = `${UNIPROT_SEARCH}?query=${encodeURIComponent(query)}&format=json&size=${limit}&fields=accession,protein_name,organism_name,gene_names,length`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      results?: Array<{
        primaryAccession?: string;
        proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
        organism?: { scientificName?: string };
        genes?: Array<{ geneName?: { value?: string } }>;
        sequence?: { length?: number };
      }>;
    };
    const results = json.results ?? [];
    return results.map((entry) => {
      const accession = entry.primaryAccession ?? '';
      const name =
        entry.proteinDescription?.recommendedName?.fullName?.value ?? `UniProt ${accession}`;
      const organism = entry.organism?.scientificName ?? '';
      const gene = entry.genes?.[0]?.geneName?.value ?? '';
      const length = entry.sequence?.length ? `${entry.sequence.length} aa` : '';
      const detailParts = [gene, organism, length].filter(Boolean);
      return {
        source: 'uniprot' as const,
        id: accession,
        title: name,
        detail: detailParts.join(' · '),
        url: `https://www.uniprot.org/uniprot/${accession}`,
      };
    });
  } catch {
    return [];
  } finally {
    cancel();
  }
}

// ─── ChEMBL (EMBL-EBI) ──────────────────────────────────────────────────────
// Bioactivity data: IC50, Ki, SAR for peptides and small molecules.

const CHEMBL_SEARCH = 'https://www.ebi.ac.uk/chembl/api/data/target/search.json';

async function fetchChEMBL(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const url = `${CHEMBL_SEARCH}?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      targets?: Array<{
        target_chembl_id?: string;
        pref_name?: string;
        organism?: string;
        target_type?: string;
      }>;
    };
    const targets = json.targets ?? [];
    return targets.map((t) => {
      const id = t.target_chembl_id ?? '';
      const name = t.pref_name ?? `ChEMBL target ${id}`;
      const detailParts = [t.target_type, t.organism].filter(Boolean);
      return {
        source: 'chembl' as const,
        id,
        title: name,
        detail: detailParts.join(' · '),
        url: `https://www.ebi.ac.uk/chembl/target_report_card/${id}/`,
      };
    });
  } catch {
    return [];
  } finally {
    cancel();
  }
}

// ─── AlphaFold DB (EMBL-EBI / DeepMind) ──────────────────────────────────────
// Predicted 3D structures for proteins without experimental PDB entries.

const ALPHAFOLD_API = 'https://alphafold.ebi.ac.uk/api';

async function fetchAlphaFold(uniprotIds: string[]): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  const refs: Reference[] = [];
  try {
    for (const uid of uniprotIds.slice(0, 3)) {
      try {
        const res = await fetch(`${ALPHAFOLD_API}/prediction/${uid}`, {
          signal,
          cache: 'no-store',
        });
        if (!res.ok) continue;
        const entries = (await res.json()) as Array<{
          entryId?: string;
          gene?: string;
          organismScientificName?: string;
          globalMetricValue?: number;
        }>;
        const entry = entries[0];
        if (!entry) continue;
        const confidence = entry.globalMetricValue
          ? `pLDDT=${entry.globalMetricValue.toFixed(1)}`
          : '';
        const detailParts = [entry.gene, entry.organismScientificName, confidence].filter(Boolean);
        refs.push({
          source: 'alphafold',
          id: entry.entryId ?? uid,
          title: `AlphaFold prediction for ${uid}`,
          detail: detailParts.join(' · '),
          url: `https://alphafold.ebi.ac.uk/entry/${uid}`,
        });
      } catch {
        continue;
      }
    }
    return refs;
  } catch {
    return [];
  } finally {
    cancel();
  }
}

// ─── STRING (UniZurich / EMBL / CPR / SIB) ───────────────────────────────────
// Protein-protein interaction networks.

const STRING_API = 'https://string-db.org/api/json';

async function fetchSTRING(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    // STRING requires species ID; 9606 = Homo sapiens
    const url = `${STRING_API}/network?identifiers=${encodeURIComponent(query)}&species=9606&limit=${limit}&caller_identity=eticahub`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const interactions = (await res.json()) as Array<{
      preferredName_A?: string;
      preferredName_B?: string;
      score?: number;
      stringId_A?: string;
    }>;
    // Deduplicate interactors
    const seen = new Set<string>();
    const refs: Reference[] = [];
    for (const i of interactions) {
      const partner = i.preferredName_B ?? '';
      if (!partner || seen.has(partner)) continue;
      seen.add(partner);
      const confidence = i.score ? `confidence=${(i.score / 1000).toFixed(2)}` : '';
      refs.push({
        source: 'string',
        id: partner,
        title: `${i.preferredName_A ?? query} ↔ ${partner} interaction`,
        detail: confidence,
        url: `https://string-db.org/network/${i.stringId_A ?? ''}`,
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

// ─── KEGG (Kyoto University) ─────────────────────────────────────────────────
// Metabolic & signaling pathway mappings.

const KEGG_FIND = 'https://rest.kegg.jp/find/pathway';

async function fetchKEGG(query: string, limit: number): Promise<Reference[]> {
  const { signal, cancel } = withTimeout(5_000);
  try {
    const url = `${KEGG_FIND}/${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text.trim().split('\n').slice(0, limit);
    return lines.map((line) => {
      const [pathId, ...rest] = line.split('\t');
      const title = rest.join(' ').trim();
      const id = (pathId ?? '').replace('path:', '');
      return {
        source: 'kegg' as const,
        id,
        title: title || `KEGG pathway ${id}`,
        detail: 'Kyoto Encyclopedia of Genes and Genomes',
        url: `https://www.kegg.jp/pathway/${id}`,
      };
    });
  } catch {
    return [];
  } finally {
    cancel();
  }
}

// ─── Main aggregator ─────────────────────────────────────────────────────────

export interface GatherOptions {
  pubmed?: number;
  pdb?: number;
  uniprot?: number;
  chembl?: number;
  alphafold?: boolean;
  string?: number;
  kegg?: number;
}

export async function gatherReferences(
  query: string,
  opts: GatherOptions = {},
): Promise<Reference[]> {
  const pubmedLimit = opts.pubmed ?? 4;
  const pdbLimit = opts.pdb ?? 3;
  const uniprotLimit = opts.uniprot ?? 2;
  const chemblLimit = opts.chembl ?? 2;
  const stringLimit = opts.string ?? 3;
  const keggLimit = opts.kegg ?? 2;
  const includeAlphaFold = opts.alphafold ?? true;

  // Fire all academic API requests in parallel — each retries once on failure
  const [papers, structures, proteins, bioactivity, interactions, pathways] =
    await Promise.all([
      withRetry(() => fetchPubMed(query, pubmedLimit)),
      withRetry(() => fetchPdb(query, pdbLimit)),
      withRetry(() => fetchUniProt(query, uniprotLimit)),
      withRetry(() => fetchChEMBL(query, chemblLimit)),
      withRetry(() => fetchSTRING(query, stringLimit)),
      withRetry(() => fetchKEGG(query, keggLimit)),
    ]);

  // AlphaFold lookups depend on UniProt IDs from the UniProt results
  let predicted: Reference[] = [];
  if (includeAlphaFold && proteins.length > 0) {
    const uniprotIds = proteins.map((p) => p.id).filter(Boolean);
    predicted = await fetchAlphaFold(uniprotIds);
  }

  return [
    ...papers,
    ...structures,
    ...proteins,
    ...bioactivity,
    ...predicted,
    ...interactions,
    ...pathways,
  ];
}

const SOURCE_LABELS: Record<ReferenceSource, string> = {
  pubmed: 'PubMed',
  pdb: 'PDB',
  uniprot: 'UniProt',
  chembl: 'ChEMBL',
  alphafold: 'AlphaFold',
  string: 'STRING',
  kegg: 'KEGG',
};

export function summarizeReferencesForPrompt(refs: Reference[]): string {
  if (refs.length === 0) return '';
  const lines = refs.map((r, i) => {
    const tag = `${SOURCE_LABELS[r.source] ?? r.source}:${r.id}`;
    const detail = r.detail ? ` (${r.detail})` : '';
    return `[${i + 1}] ${tag} — ${r.title}${detail}`;
  });
  return lines.join('\n');
}
