/**
 * /labs/diseases/[slug] — permanent per-disease hub: summary stats and the
 * best-scoring archived discoveries for that disease, with structured data.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { JsonLd } from '@/components/JsonLd';
import { discoveryDescription, discoveryTitle } from '@/lib/labs/discovery-meta';
import { breadcrumbJsonLd } from '@/lib/seo/jsonld';
import { diseasePath, diseaseResearch, resolveDisease } from '@/lib/seo/labs';
import { absoluteUrl, SITE_NAME } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const d = await resolveDisease(slug);
  if (!d) return { title: 'Disease not found' };
  const title = `${d.name} — AI-designed protein candidates | EticaHub Labs`;
  const description = `${d.count} open research run${d.count === 1 ? '' : 's'} targeting ${d.name}: designed protein sequences, ESMFold structures and pLDDT confidence from EticaHub Labs' autonomous lab. Free, CC0.`;
  const url = absoluteUrl(diseasePath(d.slug));
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: SITE_NAME, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function DiseasePage({ params }: Params): Promise<JSX.Element> {
  const { slug } = await params;
  const d = await resolveDisease(slug);
  if (!d) notFound();

  const { results, total } = await diseaseResearch(d.name);
  const folded = results.reduce((n, r) => n + r.candidates.filter((c) => c.folded).length, 0);
  const proteins = results.reduce((n, r) => n + r.candidates.length, 0);
  const scores = results.map((r) => r.bestCandidate.score).filter((s): s is number => typeof s === 'number');
  const bestScore = scores.length ? Math.max(...scores) : null;
  const targets = Array.from(new Set(results.map((r) => r.goalTitle).filter((g): g is string => !!g))).slice(0, 12);
  const url = absoluteUrl(diseasePath(d.slug));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${d.name} research — EticaHub Labs`,
    url,
    about: { '@type': 'MedicalCondition', name: d.name },
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/publicdomain/zero/1.0/',
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: total,
      itemListElement: results.slice(0, 50).map((r, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: absoluteUrl(`/labs/archive/${encodeURIComponent(r.id)}`),
        name: discoveryTitle(r),
      })),
    },
  };

  return (
    <article className="mx-auto max-w-4xl space-y-6">
      <JsonLd data={jsonLd} />
      <JsonLd
        data={breadcrumbJsonLd([
          ['EticaHub', '/'],
          ['Labs', '/labs'],
          ['Diseases', '/labs/diseases'],
          [d.name, diseasePath(d.slug)],
        ])}
      />

      <nav className="text-xs text-white/45">
        <Link href="/labs/diseases" className="hover:text-white/80">
          Diseases
        </Link>
        {' / '}
        <span className="text-white/70">{d.name}</span>
      </nav>

      <header className="space-y-2">
        <p className="text-[11px] uppercase tracking-wider text-white/45">EticaHub Labs · open research</p>
        <h1 className="text-2xl font-semibold text-white/95">{d.name}</h1>
        <p className="text-sm text-white/65">
          Autonomous protein-design runs targeting {d.name}. Each run states a hypothesis, designs candidate
          sequences with a language model, folds them with ESMFold and scores the structures. Everything below is
          public domain (CC0) and reproducible from the archived record.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-4">
        <Stat label="Research runs" value={total.toLocaleString()} />
        <Stat label="Designed proteins" value={proteins.toLocaleString()} />
        <Stat label="Folded structures" value={folded.toLocaleString()} />
        <Stat label="Best score" value={bestScore !== null ? `${bestScore}/100` : '—'} />
      </section>

      {targets.length > 0 && (
        <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="mb-2 text-[11px] uppercase tracking-wider text-white/45">Research goals</h2>
          <ul className="flex flex-wrap gap-2 text-xs">
            {targets.map((t) => (
              <li key={t} className="rounded-full border border-white/10 px-2.5 py-1 text-white/70">
                {t}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-white/80">Top discoveries</h2>
        <ol className="divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.03]">
          {results.map((r) => (
            <li key={r.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/labs/archive/${encodeURIComponent(r.id)}`}
                  className="font-medium text-white/90 hover:text-emerald-200"
                >
                  {discoveryTitle(r)}
                </Link>
                <span className="font-mono text-xs text-white/50">
                  {typeof r.bestCandidate.score === 'number' ? `${r.bestCandidate.score}/100` : 'unscored'} ·{' '}
                  {new Date(r.completedAt).toISOString().slice(0, 10)}
                </span>
              </div>
              <p className="mt-1 text-xs text-white/55">{discoveryDescription(r)}</p>
              <p className="mt-1 font-mono text-[11px] text-white/35">
                {r.candidates.length} candidate{r.candidates.length === 1 ? '' : 's'} ·{' '}
                {r.candidates.filter((c) => c.folded).length} folded · best {r.bestCandidate.sequence.length} aa
              </p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="flex flex-wrap gap-3 border-t border-white/10 pt-4 text-xs">
        <Link
          href={`/labs/archive?disease=${encodeURIComponent(d.name)}`}
          className="text-emerald-200/80 hover:text-emerald-200"
        >
          Filter the archive →
        </Link>
        <Link href="/labs" className="text-emerald-200/80 hover:text-emerald-200">
          Start a new run →
        </Link>
      </footer>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="mt-1 font-mono text-lg text-white/90">{value}</div>
    </div>
  );
}
