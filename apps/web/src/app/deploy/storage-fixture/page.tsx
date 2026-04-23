import { DeployStorageFixtureCard } from '@/components/deploy/DeployStorageFixtureCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy Sourcify Storage fixture · EticaHub' };

export default function DeployStorageFixturePage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy Sourcify Storage fixture</h1>
        <p className="text-sm text-white/60">
          One-shot deployer for the stock Remix <span className="font-mono">Storage</span> contract
          at the exact compiler settings Sourcify uses as its per-chain verification fixture. Signs
          with your connected wallet — no private key ever leaves MetaMask. Run once per chain; the
          deployed address is referenced by Sourcify&apos;s{' '}
          <span className="font-mono">chain-tests.spec.ts</span>.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys a real contract on Etica mainnet and spends real EGAZ for gas (&lt; 0.01
          EGAZ). Confirm the chain indicator reads <span className="font-mono">61803</span> before
          clicking Deploy.
        </p>
      </header>
      <DeployStorageFixtureCard />
    </div>
  );
}
