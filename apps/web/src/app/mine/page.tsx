import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero } from '@/components/PageHero';
import { MineWithUs } from '@/components/mine/MineWithUs';
import { absoluteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Mine with us · EticaHub pool',
  description: 'Mine ETI (CPU) and EGAZ (GPU) with the EticaHub pools: 0.5% fee, one-click desktop miner or a ready-made command for your own miner.',
  alternates: { canonical: absoluteUrl('/mine') },
};

export default function MinePage() {
  return (
    <div className="space-y-8">
      <PageHero
        tone="emerald"
        size="md"
        eyebrow="Mining · ETI and EGAZ"
        title="Mine with us"
        description="Mine ETI with your CPU and EGAZ with your GPU on the EticaHub pools. 0.5% fee, no signup. Download the one-click miner or copy a command for your own."
        actions={
          <>
            <Link href="/node" className="btn-tone px-3.5 py-1.5 text-xs">Run a node</Link>
            <Link href="/network" className="btn-ghost px-3.5 py-1.5 text-xs">Wallet setup</Link>
          </>
        }
      />
      <MineWithUs />
    </div>
  );
}
