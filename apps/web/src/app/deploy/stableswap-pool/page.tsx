import { DeployStableSwapCard } from '@/components/deploy/DeployStableSwapCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy StableSwap Pool · EticaHub' };

export default function DeployStableSwapPoolPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy stETX/ETX StableSwap</h1>
        <p className="text-sm text-white/60">
          Browser-side deployer for the rate-aware Curve-style AMM specialised for stETX/ETX, the
          10-year treasury LP lock, and the harvester adapter that streams admin fees through the
          existing 10/10/40/40 split. Signs with your connected wallet — no private key ever leaves
          the browser.
        </p>
        <p className="text-sm text-white/60">
          The pool itself is permissionless: public LPs can join later from{' '}
          <span className="font-mono">/pool</span> with no lock. Only the treasury seed is locked
          for 10 years, and fees never enter the timelock.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys real contracts on Etica mainnet and spends real EGAZ + 30,000,000 ETX (15M
          deposited into the stETX vault, 15M paired into the pool). Confirm the chain indicator
          reads <span className="font-mono">61803</span> before clicking Deploy.
        </p>
      </header>
      <DeployStableSwapCard />
    </div>
  );
}
