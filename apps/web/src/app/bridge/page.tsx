import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import { BridgeParamsTable } from '@/components/bridge/BridgeParamsTable';
import { UsdcBridgeCard } from '@/components/bridge/UsdcBridgeCard';
import { UsdcRouteAddressBook } from '@/components/bridge/UsdcRouteAddressBook';
import { UsdcRouteStatusBoard } from '@/components/bridge/UsdcRouteStatusBoard';
import { SourceBadge, TelemetrySection } from '@/components/telemetry/TelemetryCards';

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
    label: 'Settlement',
    value: '~2–5 min',
    detail: 'Ethereum finality + relayer delivery; first mainnet transfer landed in ~3 min',
  },
];

export default function BridgePage() {
  return (
    <div className="space-y-6">
      <PageHero
        tone="fuchsia"
        eyebrow="Cross-chain Bridge Terminal"
        title="Bridge USDC to Etica as USDC.e."
        description="Lock Circle USDC on Ethereum and receive USDC.e on Etica over Hyperlane, or burn USDC.e to release USDC back on Ethereum. 0.5% fee (capped at 50), first-time recipients get an EGAZ gas drop."
        actions={
          <>
            <Link href="/explorer" className="btn-tone px-3.5 py-1.5 text-xs">
              Explorer
            </Link>
            <Link href="/swap" className="btn-ghost px-3.5 py-1.5 text-xs">
              Swap
            </Link>
            <Link href="/status" className="btn-primary px-3.5 py-1.5 text-xs">
              System status
            </Link>
          </>
        }
        aside={
          <TelemetrySection
            title="Bridge telemetry"
            badge={<SourceBadge tone="fuchsia">bridge config + status</SourceBadge>}
            metrics={BRIDGE_STATS}
            description="Parameters come from the deployed route config; locked USDC, USDC.e supply, pending fees and the seeded pool below are read live from both chains."
          />
        }
      />

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">How it works</div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="1:1 backed"
                body="Every USDC.e is minted against USDC held by the collateral router on Ethereum; burning USDC.e releases the same USDC."
              />
              <InfoCard
                title="Signed checkpoints"
                body="A validator signs each mailbox checkpoint; the destination chain only mints or releases against a valid signature. Releases are capped at 5,000 USDC per 24h and the guardian can pause both sides."
              />
              <InfoCard
                title="Gas drop"
                body="A wallet that receives USDC.e with no EGAZ gets a small EGAZ drop from the keeper so it can move the funds."
              />
            </div>
          </div>

          <div className="surface px-4 py-3 text-xs text-white/50">
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
          <div className="surface p-3">
            <UsdcRouteStatusBoard />
          </div>
          <div className="rounded-2xl border border-white/[0.07] bg-[#07120f] p-3">
            <BridgeParamsTable />
          </div>
          <div className="rounded-2xl border border-white/[0.07] bg-[#07120f] p-3">
            <UsdcRouteAddressBook />
          </div>
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
