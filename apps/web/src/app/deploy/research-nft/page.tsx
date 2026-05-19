import { DeployResearchNftCard } from '@/components/deploy/DeployResearchNftCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy EticaResearchNFT · EticaHub' };

export default function DeployResearchNftPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Deploy EticaResearchNFT</h1>
        <p className="text-sm text-white/60">
          One-shot browser deployer for the immutable{' '}
          <span className="font-mono">EticaResearchNFT</span> ERC-721 — minted once per
          published research candidate (RES). Two transactions: deploys the on-chain SVG/JSON
          metadata library first, then deploys the NFT linked to it. Signs with your connected
          wallet — no private key ever leaves the browser. Run once per chain, then paste both
          addresses into <span className="font-mono">packages/shared/src/addresses.ts</span> so
          the labs mint flow activates.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys real contracts on Etica mainnet and spends real EGAZ for gas. Confirm
          the chain indicator reads <span className="font-mono">61803</span> before clicking
          Deploy.
        </p>
      </header>
      <DeployResearchNftCard />
    </div>
  );
}
