import { DeployDirectCard } from '@/components/deploy/DeployDirectCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Seed EticaSwap Direct · EticaHub' };

export default function SeedDirectPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Seed EticaSwap Direct</h1>
        <p className="text-sm text-white/60">
          Backs the two windows with 10 USDC.e + $10 of EGAZ and 10 USDC.e + $10 of ETI, priced off
          the public hub. Everything is prefilled: connect the whitelisted wallet, make sure it
          holds the amounts shown, and sign the seven transactions in order (wrap, send, send, mint;
          send, send, mint). Each window turns its deposit into ETX hub LP it can never withdraw, so
          this liquidity is locked for good and deepens the public pools.
        </p>
        <p className="text-sm text-amber-300/80">
          Real Etica mainnet transactions. Confirm the chain indicator reads{' '}
          <span className="font-mono">61803</span> before signing.
        </p>
      </header>
      <DeployDirectCard role="seeder" />
    </div>
  );
}
