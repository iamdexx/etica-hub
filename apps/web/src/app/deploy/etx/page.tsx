import { notFound } from 'next/navigation';
import { DeployEtxCard } from '@/components/deploy/DeployEtxCard';
import { operatorUiEnabled } from '@/lib/operatorUi';

export const metadata = { title: 'Deploy ETX · EticaHub' };

export default function DeployEtxPage() {
  if (!operatorUiEnabled()) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy ETX Token</h1>
        <p className="text-sm text-white/60">
          One-shot deployer for the EticaHub governance token (ETX). Mints the full 100M supply
          to your chosen distributor address. Signs with your connected wallet — no private key
          ever leaves MetaMask. Intended to be run once per chain, by the project operator.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: this page deploys a real token and spends real EGAZ for gas. Double-check
          you&apos;re connected to the intended chain and that the distributor address is
          correct before clicking Deploy. The 100M supply is minted exactly once and cannot be
          reassigned.
        </p>
      </header>
      <DeployEtxCard />
    </div>
  );
}
