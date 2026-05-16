import Link from 'next/link';
import { MarketVolumeStrip } from '@/components/MarketVolumeStrip';
import { PoolAddCard } from '@/components/pool/PoolAddCard';
import { PoolPositionsList } from '@/components/pool/PoolPositionsList';
import { PoolStableSwapCard } from '@/components/pool/PoolStableSwapCard';
import { TelemetrySection, SourceBadge } from '@/components/telemetry/TelemetryCards';
import { getServerGeoRestricted } from '@/lib/geoBlockServer';

export const metadata = { title: 'Pool · EticaHub' };

const POOL_STATS = [
  { label: 'Factory rule', value: 'ETX hub pairs', detail: 'Non-ETX public pairs rejected', tone: 'cyan' as const },
  { label: 'V2 LP fee', value: '0.25% to LPs', detail: 'Protocol fee model' },
  { label: 'Stable fee', value: '0.04%', detail: 'stETX/ETX stable path' },
  { label: 'New pool cost', value: '10,000 ETX', detail: 'Treasury creation fee' },
];

export default function PoolPage() {
  const geoRestricted = getServerGeoRestricted();
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-cyan-400/20 bg-[#051014] shadow-2xl shadow-cyan-950/20">
        <div className="grid gap-5 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.9fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-cyan-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
              Liquidity Terminal
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Pool liquidity with market context.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Add, manage, and monitor EticaSwap liquidity with pool rules, fee paths, positions, pair analytics, and market volume visible in one workflow.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer/pairs" className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-cyan-100 hover:bg-cyan-400/15">Pair analytics</Link>
              <Link href="/farms" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">LP farms</Link>
              <Link href="/swap" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Swap</Link>
            </div>
          </div>

          <TelemetrySection
            title="Pool telemetry"
            badge={<SourceBadge tone="cyan">config + live volume</SourceBadge>}
            metrics={POOL_STATS}
            description="Protocol configuration is shown here. Live pool turnover and swap counts come from the 24h market volume module below."
          />
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <MarketVolumeStrip />
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Pool rules</div>
            <div className="mt-4 space-y-3">
              <InfoCard title="ETX hub pairs" body="Pools pair ETX with ETI, EGAZ, or another ERC20. Non-ETX public pairs are rejected at the factory." />
              <InfoCard title="Initial price" body="For new pools, the first deposit ratio becomes the initial market price." />
              <InfoCard title="Liquid LP shares" body="LP positions are ERC20 tokens and can be withdrawn by removing liquidity from the position manager." />
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Creation fee</div>
            <p className="mt-1">Creating a new public pool costs <strong>10,000 ETX</strong>, paid to the EticaHub treasury. Adding to an existing pool is free except gas.</p>
          </div>
        </aside>

        <div className="space-y-6">
          {!geoRestricted && (
            <div className="rounded-2xl border border-cyan-400/20 bg-white/[0.03] p-3 shadow-xl shadow-cyan-950/20">
              <PoolStableSwapCard />
            </div>
          )}
          <div className="rounded-2xl border border-cyan-400/20 bg-white/[0.03] p-3 shadow-xl shadow-cyan-950/20">
            <PoolAddCard geoRestricted={geoRestricted} />
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-3">
            <PoolPositionsList geoRestricted={geoRestricted} />
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
