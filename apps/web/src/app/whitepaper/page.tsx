import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveWhitepaperHref } from '@/lib/whitepaperLinks';

const markdownComponents: Components = {
  a: ({ node: _node, href, children }) => {
    const resolved = resolveWhitepaperHref(href);
    const external = resolved !== undefined && /^https?:/i.test(resolved);
    return (
      <a
        href={resolved}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    );
  },
  table: ({ node: _node, children }) => (
    <div className="not-prose -mx-4 my-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table className="w-full min-w-[640px] border-collapse text-sm [&_td]:border [&_td]:border-white/[0.07] [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_th]:border [&_th]:border-white/[0.07] [&_th]:bg-white/[0.035] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left">
        {children}
      </table>
    </div>
  ),
  pre: ({ node: _node, children }) => (
    <pre className="overflow-x-auto rounded-lg border border-white/[0.07] bg-white/[0.035] p-3 text-xs">
      {children}
    </pre>
  ),
  code: ({ node: _node, className, children }) => (
    <code className={`${className ?? ''} break-all rounded bg-white/10 px-1 py-0.5 text-[0.85em]`}>
      {children}
    </code>
  ),
};

export const metadata: Metadata = {
  title: 'Whitepaper — EticaHub',
  description:
    'EticaHub whitepaper: ETX, the hub-and-spoke EticaSwap DEX, the USDC bridge (USDC.e), stETX staking, the Treasury Harvester, EticaLabs and research markets, governance, and independence from the Etica Protocol core team.',
};

function loadWhitepaper(): string {
  const p = path.join(process.cwd(), 'public', 'whitepaper.md');
  return fs.readFileSync(p, 'utf8');
}

const PAPER_STATS = [
  ['Version', '2.1 · Oct 2026'],
  ['Architecture', 'Hub-and-spoke'],
  ['Bridge', 'USDC ⇄ USDC.e live'],
  ['Governance', 'Community-built'],
];

const SPEC_BARS = [48, 58, 64, 82, 76, 104, 92, 122, 110, 96, 132, 118];

export default function WhitepaperPage() {
  const md = loadWhitepaper();

  return (
    <div className="space-y-8">
      <PageHero
        tone="neutral"
        eyebrow="Product Specification · v2.1"
        title="EticaHub Whitepaper"
        description="The full specification for ETX, EticaSwap, the live USDC bridge, stETX staking, the Treasury Harvester, EticaLabs, research markets, governance, and the project's independence from the Etica Protocol core team."
        actions={
          <>
            <a
              href="/whitepaper.md"
              download="eticahub-whitepaper.md"
              className="btn-ghost px-3.5 py-1.5 text-xs"
            >
              Download markdown
            </a>
            <Link
              href="https://github.com/iamdexx/etica-hub/blob/main/docs/WHITEPAPER.md"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost px-3.5 py-1.5 text-xs"
            >
              View on GitHub
            </Link>
            <Link href="/explorer" className="btn-primary px-3.5 py-1.5 text-xs">
              Open explorer
            </Link>
          </>
        }
        aside={
          <div className="surface p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="uppercase tracking-wider text-white/40">Specification map</span>
              <span className="text-white/70">live docs</span>
            </div>
            <div className="mt-4 flex h-36 items-end gap-2 rounded-xl border border-white/[0.07] bg-black/20 p-3">
              {SPEC_BARS.map((height, index) => (
                <div key={index} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <span className="w-full rounded-t bg-white/70" style={{ height }} />
                  <span className="h-1 w-full rounded bg-white/15" />
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PAPER_STATS.map(([label, value]) => (
                <div key={label} className="surface-2 p-3">
                  <div className="text-[10px] uppercase tracking-eyebrow text-white/40">
                    {label}
                  </div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
          </div>
        }
      />

      <section className="grid gap-6 lg:grid-cols-[0.72fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">Coverage</div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="Tokenomics"
                body="ETX emissions, staking mechanics, farms weighting, treasury flows, and governance assumptions."
              />
              <InfoCard
                title="Infrastructure"
                body="EticaSwap routing, bridge security, vault structure, and deployment architecture."
              />
              <InfoCard
                title="Risk disclosures"
                body="Economic, governance, liquidity, and smart-contract assumptions are documented directly in the specification."
              />
            </div>
          </div>

          <div className="surface px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Document source</div>
            <p className="mt-1">
              This page renders the canonical markdown whitepaper directly from the repository and
              ships it as part of the production app.
            </p>
          </div>
        </aside>

        <article className="prose prose-invert prose-sm w-full min-w-0 max-w-none break-words surface p-4 sm:p-6 prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-a:break-all prose-a:text-brand-accent prose-a:no-underline hover:prose-a:underline prose-code:break-all prose-code:rounded prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none md:prose-base">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {md}
          </ReactMarkdown>
        </article>
      </section>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="surface-2 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/55">{body}</p>
    </div>
  );
}
