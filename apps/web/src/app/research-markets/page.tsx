/**
 * /research-markets — public landing page for the EticaResearchMarkets
 * launchpad. Renders the tabbed list of all research-token markets
 * (Live / Pending graduation / Graduated / Sunset) and a CTA to launch
 * a new token.
 */
import type { Metadata } from 'next';
import { MarketsTabs } from '@/components/research-markets/MarketsTabs';

export const metadata: Metadata = {
  title: 'Research Markets — EticaHub',
  description:
    'Permissionless launchpad for scientific research tokens. Bonding-curve liquidity backed by a shared 5M ETX pool. Tokens graduate to /swap and /trade at 100k ETX in reserve.',
};

export default function ResearchMarketsPage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-50 sm:text-3xl">Research Markets</h1>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          Permissionless launchpad for scientific research tokens. Every market shares the same{' '}
          <span className="text-zinc-200">5,000,000 ETX</span> liquidity pool — tokens are minted
          when bought and burned when sold against the shared reserve. At{' '}
          <span className="text-zinc-200">100,000 ETX in reserve</span>, a token graduates and
          is listed on <code className="rounded bg-zinc-800 px-1">/swap</code> and{' '}
          <code className="rounded bg-zinc-800 px-1">/trade</code>. After 30 days without trades a
          market sunsets and its reserve recycles into the shared pool.
        </p>
      </header>

      <MarketsTabs />

      <footer className="mt-12 rounded-xl border border-zinc-800 bg-zinc-900/30 p-5 text-xs text-zinc-500">
        <p className="font-medium text-zinc-300">How it works</p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>1% fee per trade splits 40/30/20/10: pool / ETI LP burn / treasury / researcher.</li>
          <li>Every minted token is plain ERC-20 with on-chain metadata + auto-Sourcify verification.</li>
          <li>No external LP positions, ever — the bonding curve is the only venue.</li>
        </ul>
      </footer>
    </main>
  );
}
