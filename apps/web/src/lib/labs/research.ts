/**
 * Research aggregation helpers for the Labs planner.
 *
 * Pulls related peer-reviewed papers from PubMed (NCBI E-utilities) and
 * solved structures from the RCSB PDB. Both APIs are free, public, and
 * require no authentication — they're rate-limited by IP. We hit them
 * server-side with short timeouts so a slow/down API never blocks the
 * planner; in that case we return an empty list and let the planner
 * proceed without context.
 */

export type Reference = {
  source: 'pubmed' | 'pdb';
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

export async function gatherReferences(
  query: string,
  opts: { pubmed?: number; pdb?: number } = {},
): Promise<Reference[]> {
  const pubmedLimit = opts.pubmed ?? 4;
  const pdbLimit = opts.pdb ?? 3;
  const [papers, structures] = await Promise.all([
    fetchPubMed(query, pubmedLimit),
    fetchPdb(query, pdbLimit),
  ]);
  return [...papers, ...structures];
}

export function summarizeReferencesForPrompt(refs: Reference[]): string {
  if (refs.length === 0) return '';
  const lines = refs.map((r, i) => {
    const tag = r.source === 'pubmed' ? `PubMed:${r.id}` : `PDB:${r.id}`;
    const detail = r.detail ? ` (${r.detail})` : '';
    return `[${i + 1}] ${tag} — ${r.title}${detail}`;
  });
  return lines.join('\n');
}
