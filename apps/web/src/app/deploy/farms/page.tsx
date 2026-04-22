import { notFound } from 'next/navigation';
import { DeployETXFarmsCard } from '@/components/deploy/DeployETXFarmsCard';
import { operatorUiEnabled } from '@/lib/operatorUi';

export const metadata = { title: 'Deploy ETXFarms · EticaHub' };

export default function DeployETXFarmsPage() {
  if (!operatorUiEnabled()) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy ETXFarms</h1>
        <p className="text-sm text-white/60">
          One-shot browser deployer for <span className="font-mono">ETXFarms</span>, the LP
          staking contract that receives the 10% farms slice of every Harvester cycle. Signs
          with your connected wallet — no private key ever leaves MetaMask. Run once per
          chain, then paste the deployed address into{' '}
          <span className="font-mono">packages/shared/src/addresses.ts</span> and wire it
          into the Harvester via{' '}
          <span className="font-mono">TreasuryHarvester.setFarms</span>.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys a real contract on Etica mainnet and spends real EGAZ for gas.
          Confirm the chain indicator reads <span className="font-mono">61803</span> before
          clicking Deploy.
        </p>
      </header>
      <DeployETXFarmsCard />
    </div>
  );
}
