import { DeployStakedETXCard } from '@/components/deploy/DeployStakedETXCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy stETX · EticaHub' };

export default function DeployStakedETXPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy stETX</h1>
        <p className="text-sm text-white/60">
          One-shot browser deployer for the <span className="font-mono">StakedETX</span> ERC-4626
          vault. Signs with your connected wallet &mdash; no private key ever leaves MetaMask. Run
          once per chain, then paste the deployed address into{' '}
          <span className="font-mono">packages/shared/src/addresses.ts</span> so the{' '}
          <span className="font-mono">/stake</span> page can find it.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys a real contract on Etica mainnet and spends real EGAZ for gas. Confirm the
          chain indicator reads <span className="font-mono">61803</span> before clicking Deploy.
        </p>
      </header>
      <DeployStakedETXCard />
    </div>
  );
}
