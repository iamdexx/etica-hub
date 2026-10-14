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
          Browser-side deployer for the stETX-gated direct venue: factory, router and fee harvester,
          then the curated WEGAZ/USDC.e and ETI/USDC.e pairs (empty). Signs with your connected
          treasury wallet, one step at a time; no private key ever leaves the browser. Seeding the
          pairs is a separate page, <span className="font-mono">/deploy/direct/seed</span>, for
          whoever funds the liquidity.
        </p>
        <p className="text-sm text-white/60">
          The public EticaSwap stays hub-and-spoke through ETX. Only wallets holding the stETX
          threshold (40,000 at launch) can trade here, at 3% → 0.1% depending on their balance; the
          venue&apos;s fees follow the V2 split (10% stETX / 10% farms / 40% POL / 40% treasury).
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
