import { DeployHarvesterCard } from '@/components/deploy/DeployHarvesterCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy TreasuryHarvester · EticaHub' };

export default function DeployHarvesterPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy TreasuryHarvester</h1>
        <p className="text-sm text-white/60">
          One-shot browser deployer for <span className="font-mono">TreasuryHarvester</span>, the
          delegation contract that lets a limited-funds hot keeper EOA run the daily fee-harvest
          cycle without ever touching the treasury multisig. Signs with your connected wallet — no
          private key ever leaves the browser. Run once per chain, then paste the deployed address
          into <span className="font-mono">packages/shared/src/addresses.ts</span> and wire the
          reward sinks via <span className="font-mono">setStakedEtx</span> /{' '}
          <span className="font-mono">setFarms</span>.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys a real contract on Etica mainnet and spends real EGAZ for gas. Confirm the
          chain indicator reads <span className="font-mono">61803</span> before clicking Deploy.
        </p>
      </header>
      <DeployHarvesterCard />
    </div>
  );
}
