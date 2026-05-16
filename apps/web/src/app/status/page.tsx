import Link from 'next/link';
import type { Metadata } from 'next';
import { StatusPanel } from '@/components/StatusPanel';
import { StatusAutoRefresh } from '@/components/StatusAutoRefresh';
import {
  StatusLiquidityFlowCard,
  StatusRevenueCard,
} from '@/components/StatusRevenueCards';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Status · EticaHub',
  description:
    'Live on-chain diagnostic of EticaHub v1 mainnet deployment — factory, router, ETX, pools, reserves.',
};

const STATUS_STATS = [
  ['Network', 'Etica 61803'],
  ['Mode', 'Live RPC'],
  ['Scope', 'Core v1'],
  ['Cache', 'No build cache'],
];

export default function StatusPage() {
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-emerald-400/20 bg-[#06110e] shadow-2xl shadow-emerald-950/20">
        <div className="grid gap-5 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.9fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
              Mainnet System Terminal
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">EticaHub health, live from chain.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Live, wallet-less diagnostics for EticaHub v1 contracts, pools, reserves, revenue flow, and liquidity routing on Etica Mainnet.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer" className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-emerald-100 hover:bg-emerald-400/15">Explorer</Link>
              <Link href="/explorer/contracts" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">Contracts</Link>
              <Link href="/bridge" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Bridge status</Link>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-wider text-white/40">System summary</div>
              <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-xs text-emerald-100">force dynamic</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
              {STATUS_STATS.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-white/45">
              These are runtime and deployment properties. Live RPC diagnostics and liquidity state are shown in the modules below.
            </p>
          </div>
        </div>
      </section>

      <StatusAutoRefresh />

      <section className="grid gap-6 lg:grid-cols-[0.7fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Diagnostics</div>
            <div className="mt-4 space-y-3">
              <InfoCard title="Fresh RPC reads" body="The status page is force-dynamic and revalidate=0, so Vercel does not freeze diagnostic values at build time." />
              <InfoCard title="Revenue flow" body="Revenue and liquidity flow panels track the core EticaHub v1 accounting path." />
              <InfoCard title="Contract surface" body="Use Explorer Contracts when a status row needs deeper address, code, or verification inspection." />
            </div>
          </div>
        </aside>

        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-emerald-400/20 bg-white/[0.03] p-3 shadow-xl shadow-emerald-950/20">
              <StatusRevenueCard />
            </div>
            <div className="rounded-2xl border border-emerald-400/20 bg-white/[0.03] p-3 shadow-xl shadow-emerald-950/20">
              <StatusLiquidityFlowCard />
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-3">
            <StatusPanel />
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
