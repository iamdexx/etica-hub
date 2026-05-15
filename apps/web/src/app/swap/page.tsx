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

const TERMINAL_BARS = [48, 72, 56, 92, 68, 108, 84, 126, 96, 118, 76, 132];

export default function SwapPage() {
  const geoRestricted = getServerGeoRestricted();
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-emerald-400/20 bg-[#06110e] shadow-2xl shadow-emerald-950/20">
        <div className="grid gap-6 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.2),transparent_36%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.8fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
              EticaSwap Terminal
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Swap with scanner-grade context.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Trade EGAZ, ETI, ETX, and routed Etica assets from the same terminal surface as EticaHub Scan. Keep the swap card, TVL, volume, route status, and market entry points visible in one place.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer/pairs" className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-200 hover:bg-emerald-400/15">Pair charts</Link>
              <Link href="/explorer/tokens" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">Tokens</Link>
              <Link href="/pool" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Add liquidity</Link>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="uppercase tracking-wider text-white/40">Route depth</span>
              <span className="text-emerald-300">live monitor</span>
            </div>
            <div className="mt-4 flex h-36 items-end gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
              {TERMINAL_BARS.map((height, index) => (
                <div key={index} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <span className="w-full rounded-t bg-emerald-300/70" style={{ height }} />
                  <span className="h-1 w-full rounded bg-white/15" />
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ROUTE_STATS.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
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
