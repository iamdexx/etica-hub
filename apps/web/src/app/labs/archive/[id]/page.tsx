/**
 * /labs/archive/[id] — permanent, server-rendered permalink for one
 * archived discovery. Unlike /labs/feed/[jobId] (client-polled, 7-day job
 * TTL) this page survives forever, is crawlable, and carries OpenGraph /
 * Twitter card / JSON-LD metadata so results can be shared and indexed.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ShareButtons } from '@/components/labs/ShareButtons';
import { getArchivedResearch } from '@/lib/labs/archive';
import { LABS_JOB_TTL_MS } from '@/lib/labs/queue';
import { discoveryDescription, discoveryTitle } from '@/lib/labs/discovery-meta';
import { scoreLabel } from '@/lib/labs/plain-summary';
import { absoluteUrl, SITE_NAME } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const r = await getArchivedResearch(id);
  if (!r) return { title: 'Discovery not found' };

  const title = `${discoveryTitle(r)} — Labs`;
  const description = discoveryDescription(r);
  const url = absoluteUrl(`/labs/archive/${encodeURIComponent(id)}`);

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      type: 'article',
      publishedTime: new Date(r.completedAt).toISOString(),
      tags: [r.disease, 'protein design', 'DeSci', 'Etica'].filter((t): t is string => !!t),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export default async function ArchivedDiscoveryPage({ params }: Params): Promise<JSX.Element> {
  const { id } = await params;
  const r = await getArchivedResearch(id);
  if (!r) notFound();

  const title = discoveryTitle(r);
  const url = absoluteUrl(`/labs/archive/${encodeURIComponent(id)}`);
  const best = r.bestCandidate;
  const score = best.score;
  const timelineAvailable = Date.now() - r.completedAt < LABS_JOB_TTL_MS;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: title,
    description: discoveryDescription(r),
    url,
    identifier: r.id,
    dateCreated: new Date(r.completedAt).toISOString(),
    creator: { '@type': 'Organization', name: 'EticaHub Labs', url: absoluteUrl('/labs') },
    keywords: [r.disease, 'protein design', 'ESMFold', 'DeSci'].filter(Boolean),
    isAccessibleForFree: true,
    license: 'https://creativecommons.org/publicdomain/zero/1.0/',
    citation: r.references,
  };

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <nav className="text-xs text-white/45">
        <Link href="/labs" className="hover:text-white/80">
          Labs
        </Link>
        {' / '}
        <Link href="/labs/archive" className="hover:text-white/80">
          Archive
        </Link>
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {r.disease && (
            <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 uppercase tracking-wider text-white/60">
              {r.disease}
            </span>
          )}
          {score !== undefined && (
            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-emerald-200">
              {scoreLabel(score)} · score {score.toFixed(2)}
            </span>
          )}
          {r.minted && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 uppercase tracking-wider text-amber-200">
              minted RES NFT
            </span>
          )}
          <span className="text-white/40">{fmtDate(r.completedAt)}</span>
        </div>
        <h1 className="text-2xl font-semibold text-white/95">{title}</h1>
        {r.prompt && r.prompt !== r.goalTitle && (
          <p className="text-sm text-white/60">{r.prompt}</p>
        )}
        <ShareButtons url={url} text={`${title} — AI-designed protein on EticaHub Labs`} />
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <Card label="Hypothesis">{r.hypothesis || '—'}</Card>
        <Card label="Approach">{r.approach || '—'}</Card>
      </section>

      {(r.summary || best.rationale) && (
        <Card label="Findings">{r.summary || best.rationale}</Card>
      )}

      <Card label={`Best candidate · ${best.sequence.length} aa${best.folded ? ' · folded' : ''}${best.engine ? ` · ${best.engine}` : ''}`}>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-white/75">
          {best.sequence}
        </pre>
        {best.analysis && <p className="mt-3 text-xs text-white/60">{best.analysis}</p>}
      </Card>

      {r.references.length > 0 && (
        <Card label={`Prior art (${r.references.length})`}>
          <ul className="list-disc space-y-1 pl-5 text-xs text-white/65">
            {r.references.map((ref) => (
              <li key={ref} className="break-all">
                {/^https?:\/\//.test(ref) ? (
                  <a href={ref} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                    {ref}
                  </a>
                ) : (
                  ref
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <footer className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-4 text-xs text-white/50">
        <span>
          {r.iterations} iteration{r.iterations === 1 ? '' : 's'} · {r.candidates.length} candidate
          {r.candidates.length === 1 ? '' : 's'}
        </span>
        {timelineAvailable ? (
          <Link href={`/labs/feed/${r.jobId}`} className="text-emerald-200/80 hover:text-emerald-200">
            Full run timeline →
          </Link>
        ) : (
          <span className="text-white/35">run timeline expired · run {r.jobId}</span>
        )}
        {r.mintTxHash && (
          <Link href={`/explorer/tx/${r.mintTxHash}`} className="text-amber-200/80 hover:text-amber-200">
            Mint tx →
          </Link>
        )}
        <span className="ml-auto font-mono text-white/35">{r.id}</span>
      </footer>
    </article>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <h2 className="mb-2 text-[11px] uppercase tracking-wider text-white/45">{label}</h2>
      <div className="text-sm text-white/80">{children}</div>
    </section>
  );
}
