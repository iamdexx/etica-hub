import Link from 'next/link';
import { PageHero } from '@/components/PageHero';
import { MarketVolumeStrip } from '@/components/MarketVolumeStrip';
import { PoolAddCard } from '@/components/pool/PoolAddCard';
import { PoolPositionsList } from '@/components/pool/PoolPositionsList';
import { PoolStableSwapCard } from '@/components/pool/PoolStableSwapCard';
import { TelemetrySection, SourceBadge } from '@/components/telemetry/TelemetryCards';
import { getServerGeoRestricted } from '@/lib/geoBlockServer';

export const metadata = { title: 'Pool · EticaHub' };

const POOL_STATS = [
  {
    label: 'Factory rule',
    value: 'ETX hub pairs',
    detail: 'Non-ETX public pairs rejected',
    tone: 'cyan' as const,
  },
  { label: 'V2 LP fee', value: '0.25% to LPs', detail: 'Protocol fee model' },
  { label: 'Stable fee', value: '0.04%', detail: 'stETX/ETX stable path' },
  { label: 'New pool cost', value: '10,000 ETX', detail: 'Treasury creation fee' },
];

export default function PoolPage() {
  const geoRestricted = getServerGeoRestricted();
  return (
    <div className="space-y-6">
      <PageHero
        tone="cyan"
        eyebrow="Liquidity Terminal"
        title="Pool liquidity with market context."
        description="Add, manage, and monitor EticaSwap liquidity with pool rules, fee paths, positions, pair analytics, and market volume visible in one workflow."
        actions={
          <>
            <Link href="/explorer/pairs" className="btn-tone px-3.5 py-1.5 text-xs">
              Pair analytics
            </Link>
            <Link href="/farms" className="btn-ghost px-3.5 py-1.5 text-xs">
              LP farms
            </Link>
            <Link href="/swap" className="btn-primary px-3.5 py-1.5 text-xs">
              Swap
            </Link>
          </>
        }
        aside={
          <TelemetrySection
            title="Pool telemetry"
            badge={<SourceBadge tone="cyan">config + live volume</SourceBadge>}
            metrics={POOL_STATS}
            description="Protocol configuration is shown here. Live pool turnover and swap counts come from the 24h market volume module below."
          />
        }
      />

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <MarketVolumeStrip />
          <div className="surface p-5">
            <div className="text-[11px] uppercase tracking-eyebrow text-white/45">Pool rules</div>
            <div className="mt-4 space-y-3">
              <InfoCard
                title="ETX hub pairs"
                body="Pools pair ETX with ETI, EGAZ, or another ERC20. Non-ETX public pairs are rejected at the factory."
              />
              <InfoCard
                title="Initial price"
                body="For new pools, the first deposit ratio becomes the initial market price."
              />
              <InfoCard
                title="Liquid LP shares"
                body="LP positions are ERC20 tokens and can be withdrawn by removing liquidity from the position manager."
              />
            </div>
          </div>
          <div className="surface px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Creation fee</div>
            <p className="mt-1">
              Creating a new public pool costs <strong>10,000 ETX</strong>, paid to the EticaHub
              treasury. Adding to an existing pool is free except gas.
            </p>
          </div>
        </aside>

        <div className="space-y-6">
          {!geoRestricted && (
            <div className="surface p-3">
              <PoolStableSwapCard />
            </div>
          )}
          <div className="surface p-3">
            <PoolAddCard geoRestricted={geoRestricted} />
          </div>
          <div className="rounded-2xl border border-white/[0.07] bg-[#07120f] p-3">
            <PoolPositionsList geoRestricted={geoRestricted} />
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
