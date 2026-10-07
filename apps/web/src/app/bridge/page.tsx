import Link from 'next/link';
import { Suspense } from 'react';
import { BridgeWatcherBoard } from '@/components/bridge/BridgeWatcherBoard';
import { BridgeStatusBoard } from '@/components/bridge/BridgeStatusBoard';
import { BridgeFlowsCard } from '@/components/bridge/BridgeFlowsCard';
import { BridgeParamsTable } from '@/components/bridge/BridgeParamsTable';
import { BridgeAddressBook } from '@/components/bridge/BridgeAddressBook';
import { UsdcBridgeCard } from '@/components/bridge/UsdcBridgeCard';
import { SourceBadge, TelemetrySection, UnavailableMetric } from '@/components/telemetry/TelemetryCards';

export const metadata = { title: 'Bridge · EticaHub' };
export const dynamic = 'force-dynamic';

const BRIDGE_STATS = [
  {
    label: 'Transport',
    value: 'Hyperlane',
    detail: 'Warp route: USDC locked on Ethereum, USDC.e minted on Etica',
    tone: 'fuchsia' as const,
  },
  {
    label: 'Security',
    value: 'Validator ISM',
    detail: 'Signed checkpoints; guardian can pause either side',
  },
  {
    label: 'Release cap',
    value: '5,000 USDC / 24h',
    detail: 'Rate-limited USDC release on Ethereum',
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
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Bridge USDC to Etica as USDC.e.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Lock Circle USDC on Ethereum and receive USDC.e on Etica over Hyperlane, or burn USDC.e to release USDC back on Ethereum. 0.5% fee (capped at 50), first-time recipients get an EGAZ gas drop.
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
            <div className="text-xs uppercase tracking-wider text-white/40">How it works</div>
            <div className="mt-4 space-y-3">
              <InfoCard title="1:1 backed" body="Every USDC.e is minted against USDC held by the collateral router on Ethereum; burning USDC.e releases the same USDC." />
              <InfoCard title="Signed checkpoints" body="A validator signs each mailbox checkpoint; the destination chain only mints or releases against a valid signature. Releases are capped at 5,000 USDC per 24h and the guardian can pause both sides." />
              <InfoCard title="Gas drop" body="A wallet that receives USDC.e with no EGAZ gets a small EGAZ drop from the keeper so it can move the funds." />
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs text-white/50">
            <div className="font-medium text-white/70">Transfer flow</div>
            <ol className="mt-2 list-decimal space-y-1 pl-5 leading-5">
              <li>Approve and send USDC to the collateral router on Ethereum.</li>
              <li>The validator signs the checkpoint; the relayer delivers it to Etica.</li>
              <li>USDC.e is minted to the recipient, usually within a few minutes.</li>
              <li>Going back: burn USDC.e on Etica and USDC is released on Ethereum.</li>
            </ol>
          </div>
        </aside>

        <div className="space-y-6">
          <UsdcBridgeCard />
          <div className="rounded-2xl border border-fuchsia-400/20 bg-white/[0.03] p-3 shadow-xl shadow-fuchsia-950/20">
            <BridgeStatusBoard />
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-3">
            <Suspense
              fallback={<div className="p-2 text-xs text-white/40">Checking watcher bots…</div>}
            >
              <BridgeWatcherBoard />
            </Suspense>
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
