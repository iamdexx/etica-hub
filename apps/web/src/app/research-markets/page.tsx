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
    <div className="space-y-8">
      <header className="space-y-5" data-stagger>
        <div className="eyebrow">Research-token launchpad</div>
        <h1 className="display text-4xl sm:text-5xl md:text-6xl">Research Markets</h1>
        <p className="lede max-w-3xl">
          Permissionless launchpad for scientific research tokens. Every market shares the same{' '}
          <span className="text-white">5,000,000 ETX</span> liquidity pool — tokens are minted when
          bought and burned when sold against the shared reserve. At{' '}
          <span className="text-white">100,000 ETX in reserve</span>, a token graduates and is
          listed on <code className="rounded bg-white/10 px-1 font-mono text-[0.9em]">/swap</code>{' '}
          and <code className="rounded bg-white/10 px-1 font-mono text-[0.9em]">/trade</code>. After
          30 days without trades a market sunsets and its reserve recycles into the shared pool.
        </p>
      </header>

      <MarketsTabs />

      <footer className="surface p-5 text-xs text-white/50">
        <p className="font-medium text-white/85">How it works</p>
        <ul className="mt-2 list-inside list-disc space-y-1">
          <li>
            1% fee per trade splits <strong>80/10/0/10</strong>: pool (permanently locked POL) / ETI
            LP burn / treasury / researcher. The 80% pool slice is never withdrawable — every trade
            pulls each market&apos;s floor up forever.
          </li>
          <li>
            Every minted token is plain ERC-20 with on-chain metadata + auto-Sourcify verification.
          </li>
          <li>No external LP positions, ever — the bonding curve is the only venue.</li>
        </ul>
      </footer>
    </div>
  );
}
