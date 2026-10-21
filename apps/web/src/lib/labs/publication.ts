import type { ArchivedResearch } from './archive';

export type PublicationStatus = 'published' | 'draft';

export interface PublicationDecision {
  status: PublicationStatus;
  reasons: string[];
}

export function publicationDecision(r: ArchivedResearch): PublicationDecision {
  const reasons: string[] = [];
  const grade = r.bestCandidate.verification?.grade;
  if (!r.bestCandidate.verification?.checks.length) reasons.push('candidate checks not recorded');
  if (grade !== 'verified') reasons.push(`verification grade is ${grade ?? 'missing'}`);
  const g = r.grounding;
  if (!g) {
    reasons.push('targets and citations not checked yet');
  } else {
    if (g.policyVersion !== 2) reasons.push('grounding needs rechecking with the current policy');
    if (!Number.isFinite(g.checkedAt) || g.checkedAt <= 0)
      reasons.push('grounding timestamp missing');
    if (!g.uncheckedSymbols || g.uncheckedSymbols.length)
      reasons.push('target extraction not fully checked');
    if (!g.citationsFound.length) reasons.push('no PubMed citation resolved');
    if (g.targets.some((t) => !t.reviewed)) reasons.push('target has no reviewed UniProt entry');
    if (g.targets.length === 0) reasons.push('no named target resolved in UniProt');
    if (g.unresolvedSymbols.length > 0) {
      reasons.push(`unresolved target symbols: ${g.unresolvedSymbols.join(', ')}`);
    }
    if (g.citationsMissing.length > 0) {
      reasons.push(`cited PMIDs not found in PubMed: ${g.citationsMissing.join(', ')}`);
    }
  }
  return { status: reasons.length === 0 ? 'published' : 'draft', reasons };
}

export function isPublished(r: ArchivedResearch): boolean {
  return publicationDecision(r).status === 'published';
}

export function researchEvidence(r: ArchivedResearch) {
  const docking = r.bestCandidate.dockingConfidence;
  return {
    publication: publicationDecision(r),
    sequenceAndStructure: r.bestCandidate.verification?.grade ?? 'not-assessed',
    targetIdentifiers: r.grounding?.targets ?? [],
    citationIdentifiers: r.grounding?.citations ?? [],
    claimSupport: 'not-assessed',
    knownProteinNovelty: 'not-assessed',
    binding:
      typeof docking === 'number' && Number.isFinite(docking)
        ? { status: 'docking-prediction', score: docking }
        : { status: 'not-recorded' },
    experimental: 'not-recorded',
    clinical: 'not-recorded',
    notice:
      'Computational predictions only. Identifier resolution does not establish claim support, binding, novelty, efficacy or safety.',
  };
}
