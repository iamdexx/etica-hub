import { DeployMetadataLibCard } from '@/components/deploy/DeployMetadataLibCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const metadata = { title: 'Deploy Metadata Library · EticaHub' };

export default function DeployResearchNftMetadataPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Deploy EticaResearchNFTMetadata Library
        </h1>
        <p className="text-sm text-white/60">
          Deploys the on-chain metadata library that renders the NFT&apos;s{' '}
          <span className="font-mono">tokenURI</span> — including the fold-render image URL,
          description, and attributes. This library is linked to the{' '}
          <span className="font-mono">EticaResearchNFT</span> contract at deploy time. To upgrade
          the metadata rendering (e.g. switch from SVG to fold render), deploy a new library here
          then redeploy the NFT contract pointing at it.
        </p>
        <p className="text-sm text-amber-300/80">
          This deploys a real contract on Etica mainnet and spends real EGAZ for gas. The metadata
          library is a pure view-only library (~21 KB runtime bytecode) with zero admin surface.
        </p>
      </header>
      <DeployMetadataLibCard />
    </div>
  );
}
