import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero, SectionTitle } from '@/components/PageHero';
import { TUTORIALS, fmtDuration } from '@/lib/tutorials';
import { absoluteUrl } from '@/lib/site';

const TITLE = 'Tutorials — EticaHub';
const DESCRIPTION =
  'Short screen recordings that walk through EticaHub step by step: bridging, swapping, adding liquidity and more.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl('/tutorials') },
  openGraph: { title: TITLE, description: DESCRIPTION, url: absoluteUrl('/tutorials'), type: 'website' },
};

export default function TutorialsPage() {
  return (
    <div className="space-y-10">
      <PageHero
        tone="sky"
        size="md"
        eyebrow="Tutorials"
        title="Watch it done, then do it."
        description="Short screen recordings of real transactions on EticaHub. Each one has the steps written out under the video and a button to the page it uses."
      />

      <section className="space-y-8">
        {TUTORIALS.map((t, i) => (
          <article
            key={t.slug}
            id={t.slug}
            className="surface overflow-hidden scroll-mt-24"
          >
            <div className="grid gap-0 lg:grid-cols-[1.35fr_1fr]">
              <div className="bg-black">
                <video
                  className="aspect-video w-full"
                  controls
                  playsInline
                  preload="metadata"
                  poster={t.poster}
                  src={t.video}
                >
                  <a href={t.video}>Download the video</a>
                </video>
              </div>
              <div className="space-y-5 p-5 md:p-6">
                <SectionTitle
                  eyebrow={`Tutorial ${i + 1} · ${fmtDuration(t.duration)}`}
                  title={t.title}
                />
                <p className="text-sm leading-6 text-white/65">{t.summary}</p>
                <ol className="space-y-2.5">
                  {t.steps.map((s, n) => (
                    <li key={s} className="flex gap-3 text-sm text-white/80">
                      <span className="num mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-[11px] text-white/70">
                        {n + 1}
                      </span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Link href={t.tryIt.href} className="btn-primary">
                    {t.tryIt.label}
                  </Link>
                  <a href={t.video} download className="btn-ghost">
                    Download video
                  </a>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      <p className="text-sm text-white/50">
        More tutorials are added as features ship. Ask for one in the{' '}
        <a
          href="https://t.me/EticaHubPortal"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-accent hover:underline"
        >
          Telegram
        </a>
        .
      </p>
    </div>
  );
}
