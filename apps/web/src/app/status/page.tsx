import Link from 'next/link';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageHero } from '@/components/PageHero';
import { StatusPanel } from '@/components/StatusPanel';
import { UptimeHistory } from '@/components/UptimeHistory';
import { StatusAutoRefresh } from '@/components/StatusAutoRefresh';
import { StatusLiquidityFlowCard, StatusRevenueCard } from '@/components/StatusRevenueCards';
import {
  AutomationModule,
  BridgeModule,
  ChainModule,
  DexModule,
  IndexerModule,
  LabsModule,
  ModuleSkeleton,
  StakingModule,
} from '@/components/status/StatusModules';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Status',
  description:
    'Live health of every EticaHub system: Etica chain, EticaSwap, staking, the USDC bridge, EticaLabs, the explorer indexer and the automation that runs them.',
};

const MODULES = [
  { title: 'Etica chain · RPC', Component: ChainModule },
  { title: 'EticaSwap', Component: DexModule },
  { title: 'Staking · Farms', Component: StakingModule },
  { title: 'USDC bridge · Hyperlane', Component: BridgeModule },
  { title: 'EticaLabs', Component: LabsModule },
  { title: 'Explorer indexer', Component: IndexerModule },
] as const;

export default function StatusPage() {
  return (
    <div className="space-y-6">
      <PageHero
        tone="emerald"
        size="md"
        eyebrow="System status · Etica 61803"
        title="Every EticaHub system, live."
        description="Chain, swap, staking, bridge, Labs, indexer and the keepers that run them. Read straight from chain and the agents on every load; nothing is cached at build time."
        actions={
          <>
            <Link href="/explorer/contracts" className="btn-tone px-3.5 py-1.5 text-xs">
              Contracts
            </Link>
            <Link href="/api/v1/health" className="btn-ghost px-3.5 py-1.5 text-xs">
              Health JSON
            </Link>
            <Link href="/bridge" className="btn-primary px-3.5 py-1.5 text-xs">
              Bridge
            </Link>
          </>
        }
      />

      <StatusAutoRefresh />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {MODULES.map(({ title, Component }) => (
          <Suspense key={title} fallback={<ModuleSkeleton title={title} />}>
            <Component />
          </Suspense>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Suspense fallback={<ModuleSkeleton title="Automation · GitHub Actions" />}>
          <AutomationModule />
        </Suspense>
        <Suspense fallback={<ModuleSkeleton title="Uptime history" />}>
          <UptimeHistory />
        </Suspense>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="surface p-3">
          <StatusRevenueCard />
        </div>
        <div className="surface p-3">
          <StatusLiquidityFlowCard />
        </div>
      </section>

      <details className="surface group p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">
              Contract diagnostics
            </div>
            <p className="mt-1 text-xs text-white/55">
              Addresses, supplies, factory parameters, reactor state and pool reserves for every
              core v1 contract.
            </p>
          </div>
          <span className="text-xs text-brand-glow/80 group-open:hidden">Expand</span>
          <span className="hidden text-xs text-brand-glow/80 group-open:inline">Collapse</span>
        </summary>
        <div className="mt-4 rounded-2xl border border-white/[0.07] bg-[#07120f] p-3">
          <Suspense fallback={<ModuleSkeleton title="Reading contracts from chain…" />}>
            <StatusPanel />
          </Suspense>
        </div>
      </details>
    </div>
  );
}
