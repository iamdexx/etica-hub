import { describe, expect, it } from 'vitest';

import type { ArchivedResearch } from '@/lib/labs/archive';
import { publicationDecision } from '@/lib/labs/publication';

function record(patch: Partial<ArchivedResearch> = {}): ArchivedResearch {
  return {
    id: 'r1',
    jobId: 'j1',
    prompt: 'peptide against KRAS',
    completedAt: 1,
    hypothesis: '',
    approach: '',
    bestCandidate: {
      index: 0,
      sequence: 'ACDEFGHIK',
      rationale: '',
      folded: true,
      verification: {
        grade: 'verified',
        penalty: 1,
        adjustedScore: 0.8,
        summary: '',
        checks: [
          { id: 'plddt', label: 'Fold confidence', status: 'pass', detail: 'mean pLDDT 85' },
        ],
      },
    },
    candidates: [],
    iterations: 1,
    summary: '',
    references: [],
    minted: false,
    verificationGrade: 'verified',
    grounding: {
      policyVersion: 2,
      uncheckedSymbols: [],
      citations: [{ id: '123', title: 'A paper', url: 'https://pubmed.ncbi.nlm.nih.gov/123/' }],
      checkedAt: 1,
      summary: '',
      targets: [
        {
          symbol: 'KRAS',
          accession: 'P01116',
          entryName: 'RASK_HUMAN',
          proteinName: 'GTPase KRas',
          reviewed: true,
        },
      ],
      unresolvedSymbols: [],
      citationsFound: ['123'],
      citationsMissing: [],
    },
    ...patch,
  };
}

describe('publicationDecision', () => {
  it('publishes a verified, fully grounded record', () => {
    expect(publicationDecision(record())).toEqual({ status: 'published', reasons: [] });
  });

  it('keeps weak records as drafts', () => {
    expect(
      publicationDecision(
        record({
          bestCandidate: {
            ...record().bestCandidate,
            verification: { ...record().bestCandidate.verification!, grade: 'weak' },
          },
        }),
      ).status,
    ).toBe('draft');
  });

  it('keeps ungrounded records as drafts (lookup outage is not a pass)', () => {
    const d = publicationDecision(record({ grounding: undefined }));
    expect(d.status).toBe('draft');
    expect(d.reasons.join(' ')).toMatch(/not checked/);
  });

  it('drafts records with unresolved targets or missing citations', () => {
    const base = record().grounding!;
    expect(
      publicationDecision(record({ grounding: { ...base, unresolvedSymbols: ['ZZQX9'] } })).status,
    ).toBe('draft');
    expect(
      publicationDecision(record({ grounding: { ...base, citationsMissing: ['99999999'] } }))
        .status,
    ).toBe('draft');
    expect(publicationDecision(record({ grounding: { ...base, targets: [] } })).status).toBe(
      'draft',
    );
  });
});
