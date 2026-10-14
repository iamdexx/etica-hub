import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import { MarketVolumeStrip } from '@/components/MarketVolumeStrip';
import { SwapCard } from '@/components/swap/SwapCard';
import { TelemetrySection, SourceBadge } from '@/components/telemetry/TelemetryCards';
import { TvlBanner } from '@/components/TvlBanner';
import { GraduatedMarketsSection } from '@/components/research-markets/GraduatedMarketsSection';
import { getServerGeoRestricted } from '@/lib/geoBlockServer';

export const metadata = { title: 'Swap · EticaHub' };

const ROUTE_STATS = [
  {
    label: 'Hub route',
    value: 'ETX routed',
    detail: 'Shared routing asset',
    tone: 'emerald' as const,
  },
  { label: 'LP fee', value: '0.30%', detail: 'AMM swap fee', tone: 'emerald' as const },
  { label: 'Protection', value: 'Slippage guarded', detail: 'User-defined max impact' },
  { label: 'Markets', value: 'EGAZ · ETI · ETX · USDC.e', detail: 'Configured swap assets' },
];

export default function SwapPage() {
  const geoRestricted = getServerGeoRestricted();
  return (
    <div className="space-y-6">
      <PageHero
        tone="emerald"
        eyebrow="EticaSwap Terminal"
        title="Swap with scanner-grade context."
        description="Trade EGAZ, ETI, ETX, USDC.e, and routed Etica assets from the same terminal surface as EticaHub Scan. TVL, volume, route rules, and market entry points stay visible around the swap card."
        actions={
          <>
            <Link href="/explorer/pairs" className="btn-tone px-3.5 py-1.5 text-xs">
              Pair charts
            </Link>
            <Link href="/explorer/tokens" className="btn-ghost px-3.5 py-1.5 text-xs">
              Tokens
            </Link>
            <Link href="/pool" className="btn-primary px-3.5 py-1.5 text-xs">
              Add liquidity
            </Link>
          </>
        }
        aside={
          <TelemetrySection
            title="Route telemetry"
            badge={<SourceBadge tone="emerald">config + live modules</SourceBadge>}
            metrics={ROUTE_STATS}
            description="Protocol route configuration is shown here. Live TVL and pool volume come from the polling modules below."
          />
        }
      />

      <section className="grid gap-6 lg:grid-cols-[1fr_0.72fr] lg:items-start">
        <div className="space-y-6">
          <TvlBanner />
          <MarketVolumeStrip />
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">
              Execution notes
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <InfoCard
                title="ETX hub"
                body="Routes use ETX as the shared hub for EticaSwap markets."
              />
              <InfoCard
                title="Protected fills"
                body="Swap execution keeps slippage protection in front of every trade."
              />
              <InfoCard
                title="Market links"
                body="Jump from swap flow into tokens, pairs, and liquidity analytics."
              />
            </div>
          </div>
        </div>
        <div className="surface p-3">
          <SwapCard geoRestricted={geoRestricted} />
        </div>
      </section>

      <GraduatedMarketsSection ctaTarget="swap" />
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
