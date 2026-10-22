import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkPubmedIds,
  extractPubmedIds,
  findPubmedLiterature,
  LookupUnavailableError,
  pubmedTargetQuery,
  searchPubmed,
} from '@etica-hub/shared/labs/grounding';
import type { ArchivedResearch, GroundingRecord } from '@/lib/labs/archive';
import { recheckArchivedCitations } from '@/lib/labs/grounding';
import { publicationDecision } from '@/lib/labs/publication';

function responses(...bodies: unknown[]) {
  const mock = vi.fn();
  for (const body of bodies) mock.mockResolvedValueOnce({ ok: true, json: async () => body });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

const grounding: GroundingRecord = {
  policyVersion: 2,
  checkedAt: 1,
  uncheckedSymbols: [],
  summary: 'Original',
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
  citationsFound: [],
  citationsMissing: [],
  citations: [],
};

function record(): ArchivedResearch {
  return {
    id: 'r',
    jobId: 'j',
    completedAt: 1,
    prompt: 'KRAS',
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
        adjustedScore: 1,
        summary: '',
        checks: [{ id: 'fold', label: 'Fold', status: 'pass', detail: 'Computational only' }],
      },
    },
    candidates: [],
    iterations: 1,
    summary: '',
    references: [],
    minted: false,
    grounding,
  };
}

describe('PubMed provenance', () => {
  it('extracts short IDs and never truncates an oversized ID', () => {
    expect(extractPubmedIds(['PMID: 12; pubmed:123456789012; PMID: 12'])).toEqual([
      '12',
      '123456789012',
    ]);
  });

  it('rejects malformed IDs without sending them to NCBI', async () => {
    const mock = responses();
    expect((await checkPubmedIds(['0', '123456789012'])).missing).toEqual(['0', '123456789012']);
    expect(mock).not.toHaveBeenCalled();
  });

  it('verifies search hits against exact UIDs and retains query and metadata', async () => {
    responses(
      { esearchresult: { idlist: ['12345', '99999999'] } },
      {
        result: {
          '12345': { uid: '12345', title: 'A title', fulljournalname: 'Journal', pubdate: '2024' },
          '99999999': { uid: '99999999', error: 'cannot get document summary' },
        },
      },
    );
    const result = await searchPubmed('KRAS[Title/Abstract]');
    expect(result.query).toBe('KRAS[Title/Abstract]');
    expect(result.checkedAt).toBeGreaterThan(0);
    expect(result.citations).toEqual([
      expect.objectContaining({
        id: '12345',
        title: 'A title',
        journal: 'Journal',
        published: '2024',
      }),
    ]);
  });

  it('resolves NCBI Bookshelf records that only carry booktitle', async () => {
    responses({
      result: {
        '35377573': {
          uid: '35377573',
          title: '',
          booktitle: 'IMPACT programme',
          pubdate: '2022 Mar',
        },
      },
    });
    const r = await checkPubmedIds(['35377573']);
    expect(r.found).toEqual(['35377573']);
    expect(r.citations[0]?.title).toBe('IMPACT programme');
  });

  it.each([
    { result: { '12345': { uid: '54321', title: 'Wrong UID' } } },
    { result: { '12345': { uid: '12345', title: ' ' } } },
    { result: { '12345': { error: 'API rate limit exceeded' } } },
    { result: {} },
    { error: 'API rate limit exceeded' },
  ])('does not call malformed or rate-limited summaries missing citations: %j', async (body) => {
    responses(body);
    await expect(checkPubmedIds(['12345'])).rejects.toBeInstanceOf(LookupUnavailableError);
  });

  it('distinguishes malformed search responses from a successful empty search', async () => {
    responses({ esearchresult: {} }, { esearchresult: { idlist: [] } });
    await expect(searchPubmed('KRAS')).rejects.toBeInstanceOf(LookupUnavailableError);
    expect((await searchPubmed('KRAS')).citations).toEqual([]);
  });

  it('uses reviewed target symbols rather than an instruction sentence', async () => {
    const mock = responses(
      {
        results: [
          {
            primaryAccession: 'P01116',
            uniProtkbId: 'RASK_HUMAN',
            entryType: 'UniProtKB reviewed (Swiss-Prot)',
            genes: [{ geneName: { value: 'KRAS' } }],
          },
        ],
      },
      { esearchresult: { idlist: [] } },
    );
    const result = await findPubmedLiterature(
      'Design and test a peptide against KRAS-G12D in a new scaffold',
    );
    expect(result.query).toBe('(KRAS[Title/Abstract])');
    expect(new URL(mock.mock.calls[1][0]).searchParams.get('term')).toBe(result.query);
    expect(pubmedTargetQuery(['KRAS'], 'Pancreatic Cancer')).toBe(
      '(KRAS[Title/Abstract]) AND (Pancreatic Cancer)',
    );
  });

  it('preserves original claims while rechecking their identifiers', async () => {
    const original = record();
    original.references = ['pubmed:12345 An old title', 'pubmed:99999999 A fabricated title'];
    responses({
      result: {
        '12345': { uid: '12345', title: 'Canonical title' },
        '99999999': { error: 'cannot get document summary' },
      },
    });
    const checked = await recheckArchivedCitations(original);
    expect(checked?.citationsFound).toEqual(['12345']);
    expect(checked?.citationsMissing).toEqual(['99999999']);
    expect(checked?.checkedAt).toBe(1);
    expect(checked?.citationsCheckedAt).toBeGreaterThan(1);
    expect(original.references).toEqual([
      'pubmed:12345 An old title',
      'pubmed:99999999 A fabricated title',
    ]);
    expect(publicationDecision({ ...original, grounding: checked! }).status).toBe('draft');
  });

  it('does not turn retrospective background into candidate evidence or publication', async () => {
    const original = record();
    original.literatureContext = {
      relation: 'background-only',
      query: 'KRAS',
      checkedAt: 1,
      citations: [
        { id: '12345', title: 'Background', url: 'https://pubmed.ncbi.nlm.nih.gov/12345/' },
      ],
    };
    const mock = responses();
    const checked = await recheckArchivedCitations(original);
    expect(mock).not.toHaveBeenCalled();
    expect(checked?.citationsFound).toEqual([]);
    expect(publicationDecision({ ...original, grounding: checked! }).status).toBe('draft');
  });

  it('keeps an identifier without canonical metadata as draft', () => {
    expect(
      publicationDecision({ ...record(), grounding: { ...grounding, citationsFound: ['12345'] } })
        .status,
    ).toBe('draft');
  });
});
