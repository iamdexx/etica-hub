import { DeploySwapCard } from '@/components/deploy/DeploySwapCard';

export const metadata = { title: 'Deploy EticaSwap · EticaHub' };

export default function DeploySwapPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy EticaSwap V2</h1>
        <p className="text-sm text-white/60">
          One-shot deployer for the EticaSwap V2 stack (WEGAZ, Factory, Router). Signs with your
          connected wallet — no private key ever leaves MetaMask. Intended to be run once per
          chain, by the project operator.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: this page deploys real contracts and spends real EGAZ for gas. Double-check
          you&apos;re connected to the intended chain and that the treasury address is correct
          before clicking Deploy.
        </p>
      </header>
      <DeploySwapCard />
    </div>
  );
}
