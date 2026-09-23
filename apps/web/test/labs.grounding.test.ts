import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  checkPubmedIds,
  extractPubmedIds,
  extractTargetSymbols,
  groundingSummary,
  resolveTarget,
} from '@etica-hub/shared/labs/grounding';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(json: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => json }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('extractTargetSymbols', () => {
  it('finds gene symbols and strips mutation suffixes', () => {
    const symbols = extractTargetSymbols('helical peptide against the KRAS-G12D switch II pocket');
    expect(symbols).toContain('KRAS');
    expect(symbols).not.toContain('KRAS-G12D');
  });

  it('ignores domain vocabulary that looks like a symbol', () => {
    const symbols = extractTargetSymbols('cryo-EM and NMR data, PMID: 123456, PDAC cohort');
    expect(symbols).not.toContain('PMID');
    expect(symbols).not.toContain('PDAC');
    expect(symbols).not.toContain('NMR');
  });

  it('keeps invented symbols so they can be reported as unresolved', () => {
    expect(extractTargetSymbols('targeting ZZQX9 directly')).toContain('ZZQX9');
  });
});

describe('extractPubmedIds', () => {
  it('reads PMIDs from prose and urls', () => {
    const ids = extractPubmedIds([
      'as shown previously (PMID: 32623266)',
      'https://pubmed.ncbi.nlm.nih.gov/12345678/',
    ]);
    expect(ids).toEqual(['32623266', '12345678']);
  });
});

describe('resolveTarget', () => {
  it('prefers the entry whose gene name matches exactly', async () => {
    stubFetch({
      results: [
        {
          primaryAccession: 'X00000',
          uniProtkbId: 'OTHER_HUMAN',
          entryType: 'UniProtKB reviewed (Swiss-Prot)',
          genes: [{ geneName: { value: 'KRASP1' } }],
        },
        {
          primaryAccession: 'P01116',
          uniProtkbId: 'RASK_HUMAN',
          entryType: 'UniProtKB reviewed (Swiss-Prot)',
          proteinDescription: { recommendedName: { fullName: { value: 'GTPase KRas' } } },
          organism: { scientificName: 'Homo sapiens' },
          genes: [{ geneName: { value: 'KRAS' } }],
        },
      ],
    });
    const hit = await resolveTarget('KRAS');
    expect(hit?.accession).toBe('P01116');
    expect(hit?.reviewed).toBe(true);
  });

  it('returns null when UniProt knows nothing', async () => {
    stubFetch({ results: [] });
    expect(await resolveTarget('ZZQX9')).toBeNull();
  });

  it('returns null rather than throwing when the lookup fails', async () => {
    stubFetch({}, false);
    expect(await resolveTarget('KRAS')).toBeNull();
  });
});

describe('checkPubmedIds', () => {
  it('separates real PMIDs from fabricated ones', async () => {
    stubFetch({
      result: {
        '32623266': { uid: '32623266', title: 'Real paper' },
        '99999999': { uid: '99999999', error: 'cannot get document summary' },
      },
    });
    const { found, missing } = await checkPubmedIds(['32623266', '99999999']);
    expect(found).toEqual(['32623266']);
    expect(missing).toEqual(['99999999']);
  });

  it('treats every id as unverified when PubMed is unreachable', async () => {
    stubFetch({}, false);
    const { found, missing } = await checkPubmedIds(['32623266']);
    expect(found).toEqual([]);
    expect(missing).toEqual(['32623266']);
  });
});

describe('groundingSummary', () => {
  it('reports resolved targets and missing citations', () => {
    const summary = groundingSummary({
      grounded: [
        {
          symbol: 'KRAS',
          accession: 'P01116',
          entryName: 'RASK_HUMAN',
          proteinName: 'GTPase KRas',
          reviewed: true,
          organism: 'Homo sapiens',
        },
      ],
      unresolved: ['ZZQX9'],
      citationsFound: [],
      citationsMissing: ['99999999'],
    });
    expect(summary).toContain('KRAS (P01116)');
    expect(summary).toContain('ZZQX9');
    expect(summary).toContain('not found');
  });

  it('says so when a run names nothing at all', () => {
    expect(
      groundingSummary({ grounded: [], unresolved: [], citationsFound: [], citationsMissing: [] }),
    ).toBe('no named target or citation found');
  });
});
