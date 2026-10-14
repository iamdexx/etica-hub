import { DeployDirectCard } from '@/components/deploy/DeployDirectCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Hand off EticaSwap Direct · EticaHub' };

export default function HandoffDirectPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Hand off EticaSwap Direct</h1>
        <p className="text-sm text-white/60">
          Treasury page, for after launch and seeding. Today the treasury alone controls the Direct
          factory and harvester. Three transactions move that control to a 2-of-2 multisig (treasury
          + second signer): deploy the multisig, make it the factory admin, make it the harvester
          owner. From then on every admin change needs both signatures; unpausing stays 1-of-2. Open
          this page from the link the deploy page prints, or paste the factory address.
        </p>
        <p className="text-sm text-amber-300/80">
          Real Etica mainnet transactions. Confirm the chain indicator reads{' '}
          <span className="font-mono">61803</span> before signing.
        </p>
      </header>
      <DeployDirectCard role="handoff" />
    </div>
  );
}
