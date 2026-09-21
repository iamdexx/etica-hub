/**
 * /labs/diseases — indexable hub of every disease EticaHub Labs has
 * researched, linking to a per-disease page of archived discoveries.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { JsonLd } from '@/components/JsonLd';
import { getArchiveStats } from '@/lib/labs/archive';
import { breadcrumbJsonLd } from '@/lib/seo/jsonld';
import { diseasePath, listDiseases } from '@/lib/seo/labs';
import { absoluteUrl } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TITLE = 'Diseases researched by EticaHub Labs — AI protein design archive';
const DESCRIPTION =
  'Browse open, CC0 protein-design research by disease. Every entry is an autonomous EticaHub Labs run: hypothesis, designed sequences, ESMFold structures and pLDDT scores.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl('/labs/diseases') },
  openGraph: { title: TITLE, description: DESCRIPTION, url: absoluteUrl('/labs/diseases'), type: 'website' },
};

export default async function DiseasesPage(): Promise<JSX.Element> {
  const [diseases, stats] = await Promise.all([listDiseases(), getArchiveStats().catch(() => null)]);

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: TITLE,
    itemListElement: diseases.map((d, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: d.name,
      url: absoluteUrl(diseasePath(d.slug)),
    })),
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <JsonLd data={itemList} />
      <JsonLd data={breadcrumbJsonLd([['EticaHub', '/'], ['Labs', '/labs'], ['Diseases', '/labs/diseases']])} />

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-white/95">Research by disease</h1>
        <p className="text-sm text-white/60">{DESCRIPTION}</p>
        {stats && (
          <p className="text-xs text-white/40">
            {stats.totalResearch.toLocaleString()} archived runs · {stats.totalProteins.toLocaleString()} designed
            proteins · {stats.totalFolds.toLocaleString()} folded structures
          </p>
        )}
      </header>

      {diseases.length === 0 ? (
        <p className="text-sm text-white/50">No archived research yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {diseases.map((d) => (
            <li key={d.slug}>
              <Link
                href={diseasePath(d.slug)}
                className="block rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-emerald-300/30 hover:bg-white/[0.05]"
              >
                <div className="font-medium text-white/90">{d.name}</div>
                <div className="text-xs text-white/45">
                  {d.count} research run{d.count === 1 ? '' : 's'}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-white/45">
        <Link href="/labs/archive" className="text-emerald-200/80 hover:text-emerald-200">
          Search the full archive
        </Link>{' '}
        ·{' '}
        <Link href="/labs" className="text-emerald-200/80 hover:text-emerald-200">
          Run your own research
        </Link>
      </p>
    </div>
  );
}
