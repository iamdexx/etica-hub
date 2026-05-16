import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TradeView } from '@/components/trade/TradeView';
import {
  parseTradeBaseSymbol,
  TRADE_BASE_PAIR_IDS,
} from '@/lib/trading/baseSymbol';

export const metadata = { title: 'Trade · EticaHub' };

interface PageProps {
  params: Promise<{ token: string }> | { token: string };
}

const SIGNALS = [
  ['Order types', 'Limit · Stop · DCA'],
  ['Strategy', 'Grid · Infinity'],
  ['Settlement', 'Permit2 + UniswapX'],
  ['Market view', 'Explorer pairs'],
];

export default async function TradeTokenPage({ params }: PageProps) {
  const resolved = await Promise.resolve(params);
  const token = parseTradeBaseSymbol(resolved.token);
  if (!token) notFound();

  // Next.js server components read env at request time.
  const apiBaseUrl = process.env.NEXT_PUBLIC_PRICES_API_URL ?? process.env.PRICES_API_URL ?? '';

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-amber-400/20 bg-[#100d05] shadow-2xl shadow-amber-950/20">
        <div className="grid gap-5 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.9fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-amber-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
              Trading Terminal · {token}
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">{token} execution desk.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Trade {token} with routed execution, order strategy surfaces, Infinity Bot positioning, and a fast path into pair analytics before submitting orders.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer/pairs" className="rounded-md border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-amber-100 hover:bg-amber-400/15">Pair analytics</Link>
              <Link href="/swap" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">Quick swap</Link>
              <Link href="/pool" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Liquidity</Link>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-wider text-white/40">Execution summary</div>
              <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-xs text-amber-100">{TRADE_BASE_PAIR_IDS[token]}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
              {SIGNALS.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-white/45">
              These are supported execution modes and routing context. Live price history is handled by the trading chart inside the desk below.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.72fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Desk context</div>
            <div className="mt-4 space-y-3">
              <InfoCard title="Routed markets" body="Use the Explorer pair analytics before opening or adjusting execution strategies." />
              <InfoCard title="Advanced orders" body="Limit, stop, DCA, grid, and Infinity surfaces remain available through the existing trading engine." />
              <InfoCard title="Risk visibility" body="Keep strategy controls next to chain, pair, and liquidity context instead of isolated tabs." />
            </div>
          </div>
        </aside>
        <div className="rounded-2xl border border-amber-400/20 bg-white/[0.03] p-3 shadow-xl shadow-amber-950/20">
          <TradeView baseSymbol={token} pairId={TRADE_BASE_PAIR_IDS[token]} apiBaseUrl={apiBaseUrl} />
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
