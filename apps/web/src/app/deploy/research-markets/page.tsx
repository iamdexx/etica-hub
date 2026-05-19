import { DeployResearchMarketsCard } from '@/components/deploy/DeployResearchMarketsCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy EticaResearchMarkets · EticaHub' };

export default function DeployResearchMarketsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy EticaResearchMarkets</h1>
        <p className="text-sm text-white/60">
          One-shot browser deployer for the{' '}
          <span className="font-mono">EticaResearchMarkets</span> singleton — a custom V4-style
          router that holds the shared 5M ETX research pool and is the sole mint/burn authority
          for every <span className="font-mono">ResearchToken</span> it launches. No LP positions
          exist; all liquidity sits inside this contract and is priced via a constant-product
          bonding curve against per-market virtual reserves. Signs with your connected wallet — no
          private key ever leaves the browser. Run once per chain, then paste the deployed
          address into <span className="font-mono">packages/shared/src/addresses.ts</span> and
          transfer the 5M ETX seed into the singleton.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys a real contract on Etica mainnet and spends real EGAZ for gas. Confirm the
          chain indicator reads <span className="font-mono">61803</span> before clicking Deploy.
        </p>
      </header>
      <DeployResearchMarketsCard />
    </div>
  );
}
