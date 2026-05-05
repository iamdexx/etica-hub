import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="not-prose -mx-4 my-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table
        {...props}
        className="w-full min-w-[640px] border-collapse text-sm [&_td]:border [&_td]:border-white/10 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_th]:border [&_th]:border-white/10 [&_th]:bg-white/5 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left"
      />
    </div>
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="overflow-x-auto rounded-lg border border-white/10 bg-white/5 p-3 text-xs"
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      {...props}
      className={`${className ?? ''} break-all rounded bg-white/10 px-1 py-0.5 text-[0.85em]`}
    />
  ),
};

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
            Stableswap edition · v1.2
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

      <article className="prose prose-invert prose-sm max-w-none break-words prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-a:break-all prose-a:text-brand-accent prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none md:prose-base">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {md}
        </ReactMarkdown>
      </article>
    </div>
  );
}
