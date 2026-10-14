import { DirectWindowsCard } from '@/components/deploy/DirectWindowsCard';
import { OperatorBanner } from '@/components/OperatorBanner';

export const dynamic = 'force-dynamic';

export default function DirectWindowsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OperatorBanner />
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Open more Direct windows</h1>
        <p className="text-sm text-white/60">
          Four more V5 windows over the existing hub pools: EGAZ/ETI, stETX/USDC.e, stETX/EGAZ and
          stETX/ETI. Each is one <span className="font-mono">createMetaPair</span> through the 2-of-2:
          the first signer proposes, the second opens this page and confirms.
        </p>
      </header>
      <DirectWindowsCard role="admin" />
    </div>
  );
}
