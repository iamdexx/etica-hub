import Link from 'next/link';
import { BridgeStatusBoard } from '@/components/bridge/BridgeStatusBoard';
import { BridgeFlowsCard } from '@/components/bridge/BridgeFlowsCard';
import { BridgeParamsTable } from '@/components/bridge/BridgeParamsTable';
import { BridgeAddressBook } from '@/components/bridge/BridgeAddressBook';
import { SourceBadge, TelemetrySection, UnavailableMetric } from '@/components/telemetry/TelemetryCards';

export const metadata = { title: 'Bridge · EticaHub' };

const BRIDGE_STATS = [
  {
    label: 'Transport',
    value: 'Hyperlane',
    detail: 'Cross-chain messaging layer',
    tone: 'fuchsia' as const,
  },
  {
    label: 'Security',
    value: 'Optimistic veto',
    detail: 'Fraud-challenge protection',
  },
  {
    label: 'Challenge',
    value: '48h',
    detail: 'Claim dispute window',
  },
  {
    label: 'Bridge volume',
    value: <UnavailableMetric reason="requires relay indexer" />,
    detail: 'Cross-chain analytics pending',
  },
];

export default function BridgePage() {
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-fuchsia-400/20 bg-[#120613] shadow-2xl shadow-fuchsia-950/20">
        <div className="grid gap-5 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(217,70,239,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.9fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-fuchsia-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fuchsia-300" />
              Cross-chain Bridge Terminal
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Bridge ETX across execution domains.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Lock ETX on Etica and mint wrapped ETX on Ethereum or BNB through Hyperlane rails with optimistic-veto security and visible bridge flow telemetry.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer" className="rounded-md border border-fuchsia-400/25 bg-fuchsia-400/10 px-3 py-2 text-fuchsia-100 hover:bg-fuchsia-400/15">Explorer</Link>
              <Link href="/swap" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">Swap</Link>
              <Link href="/status" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">System status</Link>
            </div>
          </div>

          <TelemetrySection
            title="Bridge telemetry"
            badge={<SourceBadge tone="fuchsia">bridge config + status</SourceBadge>}
            metrics={BRIDGE_STATS}
            description="Bridge mechanics and dispute parameters are available now. Live relay throughput, transfer counts, and historical bridge analytics require dedicated relay indexing before accurate telemetry can be shown."
          />
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Bridge mechanics</div>
            <div className="mt-4 space-y-3">
              <InfoCard title="No LP model" body="Bridge flow locks native ETX and mints wrapped ETX instead of depending on external liquidity providers." />
              <InfoCard title="Optimistic veto" body="Claims enter a 48h challenge window where operator or community fraud proofs can veto invalid bridge execution." />
              <InfoCard title="Automatic completion" body="After the challenge period expires without veto, watcher bots finalize the claim and refund submitter bonds." />
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs text-white/50">
            <div className="font-medium text-white/70">Deposit flow</div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 leading-5">
              <li>Deposit ETX into BridgeVault on Etica.</li>
              <li>Hyperlane relays the bridge message cross-chain.</li>
              <li>Submitter posts claim bond and enters challenge period.</li>
              <li>Claim auto-executes after the veto window expires.</li>
            </ol>
          </div>
        </aside>

        <div className="space-y-6">
          <div className="rounded-2xl border border-fuchsia-400/20 bg-white/[0.03] p-3 shadow-xl shadow-fuchsia-950/20">
            <BridgeStatusBoard />
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-3">
            <BridgeFlowsCard />
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-3">
            <BridgeParamsTable />
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-3">
            <BridgeAddressBook />
          </div>
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
