import { DeployTradingCard } from '@/components/deploy/DeployTradingCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy Trading Stack · EticaHub' };

export default function DeployTradingPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy Trading Stack</h1>
        <p className="text-sm text-white/60">
          One-shot deployer for the non-custodial trading stack: Permit2 (Uniswap Labs) +
          DutchOrderReactor (UniswapX) + EticaProtocolFeeController (ours). Signs with your
          connected wallet — no private key ever leaves MetaMask. Intended to be run once per chain
          by the project operator.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: this page deploys real contracts and spends real EGAZ for gas. Double-check
          you&apos;re connected to Etica Mainnet and that the treasury address is correct before
          clicking Deploy.
        </p>
      </header>
      <DeployTradingCard />
    </div>
  );
}
