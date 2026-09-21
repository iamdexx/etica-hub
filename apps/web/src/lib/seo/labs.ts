import { listArchiveByDisease, listDiseaseFacets, type ArchivedResearch } from '@/lib/labs/archive';

export interface DiseaseFacet {
  name: string;
  slug: string;
  count: number;
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Diseases that have archived research, most-researched first. */
export async function listDiseases(): Promise<DiseaseFacet[]> {
  const facets = await listDiseaseFacets();
  return facets.map((d) => ({ name: d.name, slug: slugify(d.name), count: d.count }));
}

export async function resolveDisease(slug: string): Promise<DiseaseFacet | null> {
  const diseases = await listDiseases();
  return diseases.find((d) => d.slug === slug) ?? null;
}

const MAX_DISEASE_RECORDS = 1_000;

/** Every archived record for a disease, best-scoring first. */
export async function diseaseResearch(disease: string): Promise<ArchivedResearch[]> {
  const records = await listArchiveByDisease(disease, MAX_DISEASE_RECORDS);
  return records.sort(
    (a, b) => (b.bestCandidate.score ?? 0) - (a.bestCandidate.score ?? 0) || b.completedAt - a.completedAt,
  );
}

/** Candidate scores are stored normalised 0–1; render on the 0–100 scale. */
export function scoreOutOf100(score: number | undefined): string {
  return typeof score === 'number' ? `${Math.round(score * 100)}/100` : 'unscored';
}

export function diseasePath(slug: string): string {
  return `/labs/diseases/${slug}`;
}
