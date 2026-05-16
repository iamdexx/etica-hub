import Link from 'next/link';
import { FarmsView } from '@/components/farms/FarmsView';
import { SourceBadge, TelemetrySection, UnavailableMetric } from '@/components/telemetry/TelemetryCards';

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
      <section className="overflow-hidden rounded-2xl border border-lime-400/20 bg-[#071107] shadow-2xl shadow-lime-950/20">
        <div className="grid gap-5 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(163,230,53,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.9fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-lime-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-lime-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime-300" />
              LP Emissions Terminal
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Farm LP yield from protocol flow.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Stake EticaSwap LP positions with protocol-backed emissions, route visibility, pair analytics, and liquidity management connected into one farming workflow.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/pool" className="rounded-md border border-lime-400/25 bg-lime-400/10 px-3 py-2 text-lime-100 hover:bg-lime-400/15">Add liquidity</Link>
              <Link href="/explorer/pairs" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">Pair charts</Link>
              <Link href="/stake" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Stake ETX</Link>
            </div>
          </div>

          <TelemetrySection
            title="Farm telemetry"
            badge={<SourceBadge tone="lime">config + live farm engine</SourceBadge>}
            metrics={FARM_STATS}
            description="Reward-allocation mechanics are active now. APR, participant counts, and historical farm analytics require dedicated farm indexing before reliable live telemetry can be displayed."
          />
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Farm mechanics</div>
            <div className="mt-4 space-y-3">
              <InfoCard title="Fee-backed rewards" body="Rewards come from redistributed protocol fees instead of arbitrary inflation emissions." />
              <InfoCard title="Weighted gauges" body="stETX/ETX carries the heaviest farm weight, with EGAZ/ETX and ETI/ETX also supported." />
              <InfoCard title="No lockup" body="LP tokens remain user-controlled through the staking and unstaking flow in the farm engine." />
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Route first</div>
            <p className="mt-1">Use Pool to add liquidity, Explorer Pairs to inspect market depth, then farm the LP position here.</p>
          </div>
        </aside>

        <div className="rounded-2xl border border-lime-400/20 bg-white/[0.03] p-3 shadow-xl shadow-lime-950/20">
          <FarmsView />
        </div>
      </section>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/55">{body}</p>
    </div>
  );
}
