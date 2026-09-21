import { searchArchive, type ArchivedResearch } from '@/lib/labs/archive';

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
  const { facets } = await searchArchive({ limit: 1 });
  return facets.diseases.map((d) => ({ name: d.name, slug: slugify(d.name), count: d.count }));
}

export async function resolveDisease(slug: string): Promise<DiseaseFacet | null> {
  const diseases = await listDiseases();
  return diseases.find((d) => d.slug === slug) ?? null;
}

export async function diseaseResearch(disease: string, limit = 60): Promise<{ results: ArchivedResearch[]; total: number }> {
  const { results, total } = await searchArchive({ disease, sort: 'score', limit });
  return { results, total };
}

export function diseasePath(slug: string): string {
  return `/labs/diseases/${slug}`;
}
