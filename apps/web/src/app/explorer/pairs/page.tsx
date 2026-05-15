import Link from 'next/link';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES } from '@etica-hub/shared';
import { MarketCandles, demoCandles } from '@/components/MarketCandles';
import { MarketChartShell, MarketPill, TimeframePills } from '@/components/MarketChartShell';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
const ZERO = '0x0000000000000000000000000000000000000000';

type PairRow = {
  pair: string;
  base: string;
  quote: string;
  status: string;
  description: string;
  seed: number;
};

function knownPairs(): PairRow[] {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  const hasEtx = d?.etx && d.etx !== ZERO;
  return [
    hasEtx && ext?.eti && ext.eti !== ZERO
      ? { pair: 'ETI / ETX', base: 'ETI', quote: 'ETX', status: 'tracked', description: 'Etica token market routed through ETX.', seed: 2 }
      : null,
    hasEtx && d?.wegaz && d.wegaz !== ZERO
      ? { pair: 'WEGAZ / ETX', base: 'WEGAZ', quote: 'ETX', status: 'tracked', description: 'Wrapped gas market for EticaHub routing.', seed: 5 }
      : null,
    hasEtx
      ? { pair: 'stETX / ETX', base: 'stETX', quote: 'ETX', status: 'planned', description: 'Liquid staking market surface for yield-bearing ETX.', seed: 8 }
      : null,
  ].filter(Boolean) as PairRow[];
}

export default function PairsPage() {
  const rows = knownPairs();
  const primary = rows[0];

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">Explorer</Link>
        <span className="px-1">/</span>
        <span>Pairs</span>
      </nav>

      <section className="overflow-hidden rounded-xl border border-white/10 bg-[#07120f]">
        <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.16),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] p-6">
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/75">EticaHub Scan · Markets</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">Pairs</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
            Lightweight pair analytics surfaces for EticaHub markets. OHLC, liquidity depth, and volume panels are ready for live indexed data without requiring private RPC at render time.
          </p>
        </div>

        <div className="grid grid-cols-[1fr_0.7fr_0.7fr] gap-3 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[0.8fr_0.6fr_0.6fr_1.2fr_0.5fr]">
          <div>Pair</div>
          <div>Base</div>
          <div>Quote</div>
          <div className="hidden md:block">Description</div>
          <div className="text-right">Status</div>
        </div>

        <div className="divide-y divide-white/5">
          {rows.map((row) => (
            <div key={row.pair} className="grid grid-cols-[1fr_0.7fr_0.7fr] gap-3 px-4 py-4 text-sm md:grid-cols-[0.8fr_0.6fr_0.6fr_1.2fr_0.5fr] md:items-center">
              <div className="font-semibold text-brand-accent">{row.pair}</div>
              <div className="font-mono text-white/75">{row.base}</div>
              <div className="font-mono text-white/75">{row.quote}</div>
              <div className="hidden text-xs text-white/45 md:block">{row.description}</div>
              <div className="text-right">
                <span className={`rounded-full border px-2 py-1 text-[11px] ${row.status === 'tracked' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>
                  {row.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {primary ? (
        <MarketChartShell
          eyebrow="Pair analytics"
          title={`${primary.pair} market`}
          subtitle="Candles, volume, and liquidity depth scaffold for EticaHub pair analytics."
          actions={
            <>
              <TimeframePills active="24H" />
              <MarketPill tone="green">OHLC</MarketPill>
              <MarketPill>Volume overlay</MarketPill>
            </>
          }
        >
          <MarketCandles candles={demoCandles(primary.seed)} />
          <div className="grid border-t border-white/10 md:grid-cols-3">
            <DepthCard label="Buy depth" value="$42.8k" tone="green" />
            <DepthCard label="Sell depth" value="$31.4k" tone="red" />
            <DepthCard label="Spread" value="0.42%" tone="neutral" />
          </div>
        </MarketChartShell>
      ) : null}
    </div>
  );
}

function DepthCard({ label, value, tone }: { label: string; value: string; tone: 'green' | 'red' | 'neutral' }) {
  const color = tone === 'green' ? 'text-emerald-300' : tone === 'red' ? 'text-rose-300' : 'text-white';
  return (
    <div className="border-white/10 p-4 md:border-r">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${color}`}>{value}</div>
      <div className="mt-1 text-[11px] text-white/35">ready for indexed pool data</div>
    </div>
  );
}
