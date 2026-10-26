import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero } from '@/components/PageHero';
import { MineWithUs } from '@/components/mine/MineWithUs';
import { absoluteUrl } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Mine with us · EticaHub pool',
  description: 'EticaHub Etica (EGAZ) mining pool: 0.5% fee, PPLNS, paste your wallet and copy a ready-made command for your miner.',
  alternates: { canonical: absoluteUrl('/mine') },
};

export default function MinePage() {
  return (
    <div className="space-y-8">
      <PageHero
        tone="emerald"
        size="md"
        eyebrow="Mining · Etica etchash"
        title="Mine with us"
        description="Point your GPU at the EticaHub pool. 0.5% fee, payouts every 20 minutes, no signup. Paste your wallet, copy the command, start."
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
