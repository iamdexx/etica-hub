import { describe, expect, it } from 'vitest';

import type { ArchivedResearch } from '@/lib/labs/archive';
import { atomFeed, entrySummary, entryTitle, jsonFeed } from '@/lib/labs/feed';

const record: ArchivedResearch = {
  id: 'job-1',
  jobId: 'job-1',
  goalTitle: 'Design a <nanobody> binding the RBD & blocking ACE2',
  disease: 'COVID-19',
  prompt: 'prompt',
  completedAt: 1_700_000_000_000,
  hypothesis: 'A stabilised CDR3 loop improves affinity.',
  approach: 'x',
  bestCandidate: {
    index: 0,
    sequence: 'M'.repeat(120),
    rationale: '',
    score: 0.774,
    folded: true,
    engine: 'esmatlas',
  },
  candidates: [
    {
      index: 0,
      sequence: 'M'.repeat(120),
      rationale: '',
      score: 0.774,
      folded: true,
      engine: 'esmatlas',
    },
    { index: 1, sequence: 'A'.repeat(100), rationale: '', folded: false },
  ],
  iterations: 2,
  summary: '',
  references: [],
  minted: true,
  mintTxHash: '0xabc',
};

describe('labs feeds', () => {
  it('builds title + summary from the record', () => {
    expect(entryTitle(record)).toBe(
      'Design a <nanobody> binding the RBD & blocking ACE2 (COVID-19)',
    );
    const s = entrySummary(record);
    expect(s).toContain('A stabilised CDR3 loop');
    expect(s).toContain('77/100');
    expect(s).toContain('120 aa (esmatlas)');
    expect(s).toContain('1/2 candidates folded over 2 iterations');
  });

  it('emits well-formed Atom with escaped text and enclosure', () => {
    const xml = atomFeed([record]);
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('&lt;nanobody&gt; binding the RBD &amp; blocking');
    expect(xml).not.toContain('<nanobody>');
    expect(xml).toContain('href="https://eticahub.com/labs/archive/job-1"');
    expect(xml).toContain('rel="enclosure"');
    expect(xml).toContain('/labs/archive/job-1/opengraph-image');
    expect(xml).toContain('<category term="COVID-19"');
    expect(xml).toContain('<published>2023-11-14T22:13:20.000Z</published>');
  });

  it('emits JSON Feed 1.1 with eticahub metadata', () => {
    const feed = jsonFeed([record]);
    expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
    expect(feed.feed_url).toBe('https://eticahub.com/labs/feed.json');
    expect(feed.items).toHaveLength(1);
    const item = feed.items[0];
    expect(item.id).toBe('https://eticahub.com/labs/archive/job-1');
    expect(item.tags).toEqual(['COVID-19']);
    expect(item._eticahub).toMatchObject({
      score: 0.774,
      engine: 'esmatlas',
      residues: 120,
      folded: 1,
      candidates: 2,
      minted: true,
      api: 'https://eticahub.com/api/labs/archive/job-1',
    });
  });

  it('handles an empty archive', () => {
    expect(atomFeed([])).toContain('</feed>');
    expect(jsonFeed([]).items).toEqual([]);
  });
});
