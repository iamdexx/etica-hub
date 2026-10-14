import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { StatusPanel } from '@/components/StatusPanel';
import { UptimeHistory } from '@/components/UptimeHistory';
import { StatusAutoRefresh } from '@/components/StatusAutoRefresh';
import { StatusLiquidityFlowCard, StatusRevenueCard } from '@/components/StatusRevenueCards';
import { SourceBadge, TelemetrySection } from '@/components/telemetry/TelemetryCards';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Status · EticaHub',
  description:
    'Live on-chain diagnostic of EticaHub v1 mainnet deployment — factory, router, ETX, pools, reserves.',
};

const STATUS_STATS = [
  {
    label: 'Network',
    value: 'Etica 61803',
    detail: 'Primary execution chain',
    tone: 'emerald' as const,
  },
  {
    label: 'Mode',
    value: 'Live RPC',
    detail: 'Direct on-chain reads',
  },
  {
    label: 'Scope',
    value: 'Core v1',
    detail: 'Mainnet deployment diagnostics',
  },
  {
    label: 'Cache',
    value: 'No build cache',
    detail: 'force-dynamic + revalidate=0',
  },
];

export default function StatusPage() {
  return (
    <div className="space-y-6">
      <PageHero
        tone="emerald"
        eyebrow="Mainnet System Terminal"
        title="EticaHub health, live from chain."
        description="Live wallet-less diagnostics for EticaHub v1 contracts, reserves, pools, liquidity routes, revenue flow, and runtime health across the Etica execution layer."
        actions={
          <>
            <Link href="/explorer" className="btn-tone px-3.5 py-1.5 text-xs">
              Explorer
            </Link>
            <Link href="/explorer/contracts" className="btn-ghost px-3.5 py-1.5 text-xs">
              Contracts
            </Link>
            <Link href="/bridge" className="btn-primary px-3.5 py-1.5 text-xs">
              Bridge status
            </Link>
          </>
        }
        aside={
          <TelemetrySection
            title="System telemetry"
            badge={<SourceBadge tone="emerald">live diagnostics</SourceBadge>}
            metrics={STATUS_STATS}
            description="Status diagnostics are intentionally force-dynamic to prevent stale build-time telemetry. Revenue, reserve, and liquidity diagnostics are rendered live in the modules below."
          />
        }
      />

      <StatusAutoRefresh />

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">Diagnostics</div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="Fresh RPC reads"
                body="The status page is force-dynamic and revalidate=0, so Vercel does not freeze diagnostic values at build time."
              />
              <InfoCard
                title="Revenue flow"
                body="Revenue and liquidity flow panels track the core EticaHub v1 accounting path."
              />
              <InfoCard
                title="Contract surface"
                body="Use Explorer Contracts when a status row needs deeper address, code, or verification inspection."
              />
            </div>
          </div>
          <Suspense fallback={<PanelSkeleton label="Loading uptime history…" />}>
            <UptimeHistory />
          </Suspense>
        </aside>

        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="surface p-3">
              <StatusRevenueCard />
            </div>
            <div className="surface p-3">
              <StatusLiquidityFlowCard />
            </div>
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-[#07120f] p-3">
            <Suspense fallback={<PanelSkeleton label="Reading contracts from chain…" />}>
              <StatusPanel />
            </Suspense>
          </div>
        </div>
      </section>
    </div>
  );
}

function PanelSkeleton({ label }: { label: string }) {
  return (
    <div className="animate-pulse space-y-3 surface p-5">
      <div className="h-3 w-40 rounded bg-white/10" />
      <div className="h-3 w-full rounded bg-white/[0.035]" />
      <div className="h-3 w-5/6 rounded bg-white/[0.035]" />
      <div className="text-[11px] text-white/40">{label}</div>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="surface-2 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/55">{body}</p>
    </div>
  );
}
