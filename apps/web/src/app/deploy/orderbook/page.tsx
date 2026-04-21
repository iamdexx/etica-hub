import { notFound } from 'next/navigation';
import { DeployOrderbookCard } from '@/components/deploy/DeployOrderbookCard';
import { operatorUiEnabled } from '@/lib/operatorUi';

export const metadata = { title: 'Deploy OrderRegistry · EticaHub' };

export default function DeployOrderbookPage() {
  if (!operatorUiEnabled()) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy OrderRegistry</h1>
        <p className="text-sm text-white/60">
          One-shot deployer for the permissionless on-chain orderbook. No constructor args,
          no ownership, no config — once deployed, the contract is immutable public
          infrastructure. Replaces the hosted off-chain orderbook API in the trading-bot
          pipeline.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: this page deploys a real contract and spends real EGAZ for gas.
          Double-check you&apos;re connected to Etica Mainnet before clicking Deploy.
        </p>
      </header>
      <DeployOrderbookCard />
    </div>
  );
}
