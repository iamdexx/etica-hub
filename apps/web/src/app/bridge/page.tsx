import { BridgeCard } from '@/components/bridge/BridgeCard';
import { ClaimCard } from '@/components/bridge/ClaimCard';

export const metadata = { title: 'Bridge · EticaHub' };

export default function BridgePage() {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Bridge</h1>
        <p className="text-sm text-white/60">
          Lock ETI on Etica to mint wETI on Ethereum, or burn wETI back to
          release ETI. 2-of-3 validator multisig, pluggable to a light client
          later. Fees charged only on the destination side.
        </p>
      </header>
      <BridgeCard />
      <ClaimCard />
      <p className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-white/50">
        Bridge contracts are open-source and tested (21/21 Foundry tests
        passing) but <strong>not deployed</strong> anywhere yet. They ship
        after an independent audit. Claim addresses stay zero until
        deployment.
      </p>
    </div>
  );
}
