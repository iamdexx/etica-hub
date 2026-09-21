/**
 * Syndication feeds for the Labs research archive (Atom + JSON Feed 1.1).
 * Lets researchers, aggregators and bots subscribe to every new discovery
 * without scraping the archive UI.
 */

import { absoluteUrl, SITE_NAME } from '@/lib/site';
import { scoreOutOf100 } from '@/lib/seo/labs';

import type { ArchivedResearch } from './archive';
import { archiveImageUrl, archiveUrl } from './announce';

export const FEED_LIMIT = 50;
export const ATOM_PATH = '/labs/feed.xml';
export const JSON_FEED_PATH = '/labs/feed.json';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function entryTitle(r: ArchivedResearch): string {
  const base = (r.goalTitle ?? r.prompt).replace(/\s+/g, ' ').trim();
  return r.disease ? `${base} (${r.disease})` : base;
}

export function entrySummary(r: ArchivedResearch): string {
  const best = r.bestCandidate;
  const folded = r.candidates.filter((c) => c.folded).length;
  const parts = [
    r.hypothesis?.trim(),
    `Best candidate ${scoreOutOf100(best?.score)}, ${best?.sequence?.length ?? 0} aa` +
      (best?.engine ? ` (${best.engine})` : '') +
      `; ${folded}/${r.candidates.length} candidates folded over ${r.iterations} iteration${r.iterations === 1 ? '' : 's'}.`,
  ];
  return parts.filter(Boolean).join(' ');
}

export function atomFeed(records: ArchivedResearch[], updatedAt = Date.now()): string {
  const feedUrl = absoluteUrl(ATOM_PATH);
  const latest = records[0]?.completedAt ?? updatedAt;
  const entries = records
    .map((r) => {
      const url = archiveUrl(r.id);
      return [
        '  <entry>',
        `    <id>${esc(url)}</id>`,
        `    <title>${esc(entryTitle(r))}</title>`,
        `    <link rel="alternate" type="text/html" href="${esc(url)}"/>`,
        `    <link rel="enclosure" type="image/png" href="${esc(archiveImageUrl(r.id))}"/>`,
        `    <published>${iso(r.completedAt)}</published>`,
        `    <updated>${iso(r.completedAt)}</updated>`,
        r.disease ? `    <category term="${esc(r.disease)}"/>` : null,
        `    <summary type="text">${esc(entrySummary(r))}</summary>`,
        '  </entry>',
      ]
        .filter((l): l is string => l !== null)
        .join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${esc(feedUrl)}</id>`,
    `  <title>${esc(SITE_NAME)} Labs — research discoveries</title>`,
    '  <subtitle>Every protein design completed by the autonomous EticaHub Labs pipeline, newest first.</subtitle>',
    `  <link rel="self" type="application/atom+xml" href="${esc(feedUrl)}"/>`,
    `  <link rel="alternate" type="text/html" href="${esc(absoluteUrl('/labs/archive'))}"/>`,
    `  <updated>${iso(latest)}</updated>`,
    `  <author><name>${esc(SITE_NAME)} Labs</name><uri>${esc(absoluteUrl('/labs'))}</uri></author>`,
    entries,
    '</feed>',
    '',
  ].join('\n');
}

export function jsonFeed(records: ArchivedResearch[]): Record<string, unknown> {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: `${SITE_NAME} Labs — research discoveries`,
    home_page_url: absoluteUrl('/labs/archive'),
    feed_url: absoluteUrl(JSON_FEED_PATH),
    description:
      'Every protein design completed by the autonomous EticaHub Labs pipeline, newest first.',
    icon: absoluteUrl('/etx-logo-512.png'),
    favicon: absoluteUrl('/etx-logo-200.png'),
    items: records.map((r) => ({
      id: archiveUrl(r.id),
      url: archiveUrl(r.id),
      title: entryTitle(r),
      summary: entrySummary(r),
      content_text: entrySummary(r),
      image: archiveImageUrl(r.id),
      date_published: iso(r.completedAt),
      tags: r.disease ? [r.disease] : [],
      _eticahub: {
        score: r.bestCandidate?.score ?? null,
        engine: r.bestCandidate?.engine ?? null,
        residues: r.bestCandidate?.sequence?.length ?? 0,
        folded: r.candidates.filter((c) => c.folded).length,
        candidates: r.candidates.length,
        minted: r.minted,
        api: absoluteUrl(`/api/labs/archive/${encodeURIComponent(r.id)}`),
      },
    })),
  };
}
