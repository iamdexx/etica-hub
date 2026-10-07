import { BridgeOwnerSetupCard } from '@/components/deploy/BridgeOwnerSetupCard';
import { DeployBridgeCard } from '@/components/deploy/DeployBridgeCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy USDC.e bridge · EticaHub' };

export default function DeployBridgePage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy the USDC.e bridge</h1>
        <p className="text-sm text-white/60">
          Mainnet deployer for the Hyperlane USDC (Ethereum) → USDC.e (Etica) route: Hyperlane core
          on Etica, both routers, the rate-limit / pause ISMs and the fee contracts. The keeper
          wallet signs one authorisation here; the deploy itself runs the fork-tested{' '}
          <span className="font-mono">infra/hyperlane/deploy.sh</span> inside the{' '}
          <span className="font-mono">Bridge deploy</span> GitHub workflow with the same keeper key,
          which never leaves GitHub. Addresses appear below when the run finishes.
        </p>
        <p className="text-sm text-amber-300/80">
          A confirmed run spends real ETH and EGAZ from the keeper. Owner = treasury, fees → keeper,
          5,000 USDC/day launch cap. Run the pre-flight first.
        </p>
      </header>
      <div className="space-y-6">
        <BridgeOwnerSetupCard />
        <DeployBridgeCard />
      </div>
    </div>
  );
}
