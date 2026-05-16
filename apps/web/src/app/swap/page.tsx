import Link from 'next/link';
import { MarketVolumeStrip } from '@/components/MarketVolumeStrip';
import { SwapCard } from '@/components/swap/SwapCard';
import { TvlBanner } from '@/components/TvlBanner';
import { getServerGeoRestricted } from '@/lib/geoBlockServer';

export const metadata = { title: 'Swap · EticaHub' };

const ROUTE_STATS = [
  ['Hub route', 'ETX routed'],
  ['LP fee', '0.30%'],
  ['Protection', 'Slippage guarded'],
  ['Markets', 'EGAZ · ETI · ETX'],
];

export default function SwapPage() {
  const geoRestricted = getServerGeoRestricted();
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-emerald-400/20 bg-[#06110e] shadow-2xl shadow-emerald-950/20">
        <div className="grid gap-5 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.9fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
              EticaSwap Terminal
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Swap with scanner-grade context.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Trade EGAZ, ETI, ETX, and routed Etica assets from the same terminal surface as EticaHub Scan. TVL, volume, route rules, and market entry points stay visible around the swap card.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer/pairs" className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200 hover:bg-emerald-400/15">Pair charts</Link>
              <Link href="/explorer/tokens" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">Tokens</Link>
              <Link href="/pool" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Add liquidity</Link>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="text-xs uppercase tracking-wider text-white/40">Route summary</div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
              {ROUTE_STATS.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-white/45">
              These are protocol rules and route labels, not a live chart. Real swap telemetry is shown in the TVL and volume modules below.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_0.72fr] lg:items-start">
        <div className="space-y-6">
          <TvlBanner />
          <MarketVolumeStrip />
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Execution notes</div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <InfoCard title="ETX hub" body="Routes use ETX as the shared hub for EticaSwap markets." />
              <InfoCard title="Protected fills" body="Swap execution keeps slippage protection in front of every trade." />
              <InfoCard title="Market links" body="Jump from swap flow into tokens, pairs, and liquidity analytics." />
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-400/20 bg-white/[0.03] p-3 shadow-xl shadow-emerald-950/20">
          <SwapCard geoRestricted={geoRestricted} />
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
