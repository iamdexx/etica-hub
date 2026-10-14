import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import { FarmsView } from '@/components/farms/FarmsView';
import {
  SourceBadge,
  TelemetrySection,
  UnavailableMetric,
} from '@/components/telemetry/TelemetryCards';

export const metadata = { title: 'Farms · EticaHub' };

const FARM_STATS = [
  {
    label: 'Reward source',
    value: 'Protocol fees',
    detail: 'Harvest-backed emissions',
    tone: 'lime' as const,
  },
  {
    label: 'Farms slice',
    value: '10% harvest',
    detail: 'Treasury distribution rule',
  },
  {
    label: 'APR telemetry',
    value: <UnavailableMetric reason="requires farm indexer" />,
    detail: 'APR aggregation pending',
  },
  {
    label: 'Active LPs',
    value: <UnavailableMetric reason="requires wallet analytics" />,
    detail: 'Farm participant telemetry pending',
  },
];

export default function FarmsPage() {
  return (
    <div className="space-y-6">
      <PageHero
        tone="lime"
        eyebrow="LP Emissions Terminal"
        title="Farm LP yield from protocol flow."
        description="Stake EticaSwap LP positions with protocol-backed emissions, route visibility, pair analytics, and liquidity management connected into one farming workflow."
        actions={
          <>
            <Link href="/pool" className="btn-tone px-3.5 py-1.5 text-xs">
              Add liquidity
            </Link>
            <Link href="/explorer/pairs" className="btn-ghost px-3.5 py-1.5 text-xs">
              Pair charts
            </Link>
            <Link href="/stake" className="btn-primary px-3.5 py-1.5 text-xs">
              Stake ETX
            </Link>
          </>
        }
        aside={
          <TelemetrySection
            title="Farm telemetry"
            badge={<SourceBadge tone="lime">config + live farm engine</SourceBadge>}
            metrics={FARM_STATS}
            description="Reward-allocation mechanics are active now. APR, participant counts, and historical farm analytics require dedicated farm indexing before reliable live telemetry can be displayed."
          />
        }
      />

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">
              Farm mechanics
            </div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="Fee-backed rewards"
                body="Rewards come from redistributed protocol fees instead of arbitrary inflation emissions."
              />
              <InfoCard
                title="Weighted gauges"
                body="stETX/ETX carries the heaviest farm weight, with EGAZ/ETX and ETI/ETX also supported."
              />
              <InfoCard
                title="No lockup"
                body="LP tokens remain user-controlled through the staking and unstaking flow in the farm engine."
              />
            </div>
          </div>
          <div className="surface px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Route first</div>
            <p className="mt-1">
              Use Pool to add liquidity, Explorer Pairs to inspect market depth, then farm the LP
              position here.
            </p>
          </div>
        </aside>

        <div className="surface p-3">
          <FarmsView />
        </div>
      </section>
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
