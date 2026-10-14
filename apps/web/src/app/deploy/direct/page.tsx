import { DeployDirectCard } from '@/components/deploy/DeployDirectCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy EticaSwap Direct · EticaHub' };

export default function DeployDirectPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy EticaSwap Direct</h1>
        <p className="text-sm text-white/60">
          Treasury page. Every button below is one transaction signed by the connected treasury
          wallet, top to bottom: deploy the four contracts (factory, window deployer, router, fee
          harvester), then configure them and open the EGAZ/USDC.e and ETI/USDC.e windows. Nobody
          else signs anything here. Seeding is the seeder&apos;s own page ({' '}
          <span className="font-mono">/deploy/direct/seed</span>, link printed at the end) and
          handing admin to the 2-of-2 is <span className="font-mono">/deploy/direct/handoff</span>,
          for later.
        </p>
        <p className="text-sm text-white/60">
          Only wallets holding the stETX threshold (40,000 at launch) can trade here, at 3% → 0.1%
          depending on their balance; fees split 10% stETX / 10% farms / 40% POL back into the hub /
          40% treasury, paid in USDC.e. Nothing deposited into a window can ever be withdrawn.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys real contracts on Etica mainnet and spends real EGAZ, USDC.e and ETI. Confirm
          the chain indicator reads <span className="font-mono">61803</span> before signing.
        </p>
      </header>
      <DeployDirectCard role="operator" />
    </div>
  );
}
