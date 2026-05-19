/**
 * /research-markets/launch — researcher-facing launch form. Pays the
 * launch toll, deploys a ResearchToken, initializes the bonding curve.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { LaunchForm } from '@/components/research-markets/LaunchForm';

export const metadata: Metadata = {
  title: 'Launch Research Token — EticaHub',
  description: 'Launch a research token on the EticaResearchMarkets shared-pool bonding curve.',
};

export default function LaunchResearchMarketPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <Link
          href="/research-markets"
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          ← Back to markets
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-zinc-50 sm:text-3xl">Launch Research Token</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Deploys a new ERC-20 research token, attaches on-chain metadata (image, description,
          socials, evidence reference), pays the launch toll, and initializes the bonding curve
          against the shared 5M ETX pool. Anyone can buy or sell immediately afterward.
        </p>
      </header>

      <LaunchForm />
    </main>
  );
}
