import type { ArchivedResearch } from './archive';

export function discoveryTitle(r: ArchivedResearch): string {
  return (r.goalTitle || r.prompt || `Research ${r.jobId}`).trim().slice(0, 120);
}

export function discoveryDescription(r: ArchivedResearch): string {
  const parts = [
    r.disease ? `${r.disease}:` : null,
    r.hypothesis || r.summary || r.bestCandidate.rationale,
  ].filter(Boolean);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'AI-designed protein candidate from EticaHub Labs.';
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}
