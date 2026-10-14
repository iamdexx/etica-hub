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
          Opens the two direct pools with 10 USDC.e + $10 of EGAZ and 10 USDC.e + $10 of ETI, priced
          off the public hub so they start exactly in line. Everything is prefilled: connect your
          wallet, make sure it holds the amounts shown, and sign the four transactions in order (two
          approvals, two seeds). The LP is sent to the dead address, so this liquidity is locked for
          good.
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
