import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const metadata: Metadata = {
  title: 'API — EticaHub',
  description:
    'Public, read-only JSON and plain-text price + supply + market-data endpoints on EticaHub. CoinGecko-compatible. No auth, permissive CORS, cached 30s.',
};

function loadDocs(): string {
  const p = path.join(process.cwd(), 'public', 'price-api.md');
  return fs.readFileSync(p, 'utf8');
}

interface EndpointRow {
  method: 'GET';
  pathTemplate: string;
  example: string;
  summary: string;
}

const ENDPOINTS: EndpointRow[] = [
  {
    method: 'GET',
    pathTemplate: '/api/v1/tokens',
    example: '/api/v1/tokens',
    summary: 'List every token the API reports on (id, symbol, decimals, address).',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/tokens/[id]',
    example: '/api/v1/tokens/etx',
    summary: 'Per-token live snapshot — supply stats + spot prices vs every other tracked token.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/supply/total?token=etx',
    example: '/api/v1/supply/total?token=etx',
    summary: 'Plain-text total supply, ERC-20 decimals-formatted. Paste directly into CoinGecko/CMC forms.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/supply/circulating?token=etx',
    example: '/api/v1/supply/circulating?token=etx',
    summary: 'Plain-text circulating supply (total minus balance at 0x…dEaD).',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/supply/burned?token=etx',
    example: '/api/v1/supply/burned?token=etx',
    summary: 'Plain-text balance at the canonical POL-burn address.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/pairs',
    example: '/api/v1/pairs',
    summary: 'Every EticaSwap V2 pair with live reserves and ETX-denominated spot.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/pairs/[address]',
    example: '/api/v1/pairs/0x7009DED3686b61fa3ae2c5E5cEe56042BefEBE68',
    summary: 'Detail view for a single pair address. Both price directions.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/simple/price?ids=…&vs_currencies=…',
    example: '/api/v1/simple/price?ids=etx,eti,egaz&vs_currencies=etx,egaz',
    summary: 'CoinGecko-compatible price lookup with one-hop routing via ETX.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/ohlcv/[pair]?interval=1h&limit=100',
    example: '/api/v1/ohlcv/ETI-ETX?interval=1h&limit=100',
    summary: 'Short-range OHLC candles derived from pair Sync events.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/pools',
    example: '/api/v1/pools',
    summary: 'GeckoTerminal-style pools schema with native token0/token1 orientation.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/stats',
    example: '/api/v1/stats',
    summary: 'Status-page snapshot: head block, pair count, tracked tokens.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/health',
    example: '/api/v1/health',
    summary: 'Liveness check for aggregator bots (200 healthy / 503 stale).',
  },
];

export default function ApiDocsPage() {
  const md = loadDocs();

  return (
    <div className="space-y-8">
      <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-wider text-white/70">
            Public API · v1
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            EticaHub API
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Read-only JSON and plain-text endpoints for live prices, pair state, and token supply
            on Etica mainnet (chain id 61803). No auth, permissive CORS, cached 30s.
            CoinGecko-compatible shapes where possible.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            href="/price-api.md"
            download="eticahub-price-api.md"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:border-white/20 hover:text-white"
          >
            Download .md
          </a>
          <Link
            href="https://github.com/iamdexx/etica-hub/blob/main/docs/PRICE_API.md"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:border-white/20 hover:text-white"
          >
            View on GitHub
          </Link>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Endpoints</h2>
          <span className="text-xs text-white/50">Click any URL to hit it live</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/50">
                <th className="py-2 pr-4">Path</th>
                <th className="py-2 pr-4">Summary</th>
                <th className="py-2">Try it</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={e.pathTemplate} className="border-b border-white/5 align-top">
                  <td className="py-3 pr-4 font-mono text-xs text-white/80">{e.pathTemplate}</td>
                  <td className="py-3 pr-4 text-white/70">{e.summary}</td>
                  <td className="py-3">
                    <a
                      href={e.example}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[11px] text-brand-accent hover:border-white/20 hover:underline"
                    >
                      {e.example}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <article className="prose prose-invert prose-sm max-w-none prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-a:text-brand-accent prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none prose-table:text-sm prose-th:border prose-th:border-white/10 prose-th:bg-white/5 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-white/10 prose-td:px-3 prose-td:py-2 md:prose-base">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
      </article>
    </div>
  );
}
