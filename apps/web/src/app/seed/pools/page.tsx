import { notFound } from 'next/navigation';
import { SeedPoolsCard } from '@/components/deploy/SeedPoolsCard';
import { operatorUiEnabled } from '@/lib/operatorUi';

export const metadata = { title: 'Seed pools · EticaHub' };

export default function SeedPoolsPage() {
  if (!operatorUiEnabled()) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Seed initial pools</h1>
        <p className="text-sm text-white/60">
          One-shot liquidity-seeder for the two launch pools: ETI/ETX and EGAZ/ETX. Signs with
          your connected wallet — no private key ever leaves MetaMask. Intended to be run once
          per chain, by the project operator, directly after <a className="text-emerald-400 underline" href="/deploy/etx">/deploy/etx</a>.
        </p>
        <p className="text-sm text-amber-300/80">
          Warning: this page moves real tokens and real EGAZ into on-chain pools. Double-check
          addresses and amounts before each signature. LP tokens are minted to your connected
          wallet.
        </p>
      </header>
      <SeedPoolsCard />
    </div>
  );
}
