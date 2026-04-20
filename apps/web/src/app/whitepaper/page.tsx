import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const metadata: Metadata = {
  title: 'Whitepaper — EticaHub',
  description:
    'EticaHub v1 whitepaper: ETX token, hub-and-spoke DEX, launch parameters, governance, and independence from the Etica Protocol core team.',
};

function loadWhitepaper(): string {
  const p = path.join(process.cwd(), 'public', 'whitepaper.md');
  return fs.readFileSync(p, 'utf8');
}

export default function WhitepaperPage() {
  const md = loadWhitepaper();

  return (
    <div className="space-y-8">
      <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-wider text-white/70">
            Launch edition · v1.0
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            EticaHub Whitepaper
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Community-built, independent of the Etica Protocol core team. The full design, launch
            parameters, and risks of ETX + EticaSwap v1.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            href="/whitepaper.md"
            download="eticahub-whitepaper.md"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:border-white/20 hover:text-white"
          >
            Download .md
          </a>
          <Link
            href="https://github.com/iamdexx/etica-hub/blob/main/docs/WHITEPAPER.md"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:border-white/20 hover:text-white"
          >
            View on GitHub
          </Link>
        </div>
      </section>

      <article className="prose prose-invert prose-sm max-w-none prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-a:text-brand-accent prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none prose-table:text-sm prose-th:border prose-th:border-white/10 prose-th:bg-white/5 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-white/10 prose-td:px-3 prose-td:py-2 md:prose-base">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </article>
    </div>
  );
}
