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
          Browser-side deployer for the stETX-gated Direct venue: factory, window deployer, router
          and fee harvester, then the EGAZ/USDC.e and ETI/USDC.e windows (hub metapairs whose
          liquidity is V2 hub LP and whose swaps settle through ETX). Signs with your connected
          treasury wallet, one step at a time; no private key ever leaves the browser. The last
          three steps hand admin to the 2-of-2 multisig. Seeding is a separate page,{' '}
          <span className="font-mono">/deploy/direct/seed</span>, for the whitelisted wallet.
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
