import Link from 'next/link';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';
import { BrandCandleChartCard } from '@/components/BrandCandleChartCard';
import { explorerClient } from '@/lib/explorer';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
const ZERO = '0x0000000000000000000000000000000000000000';

type PairRow = {
  pair: string;
  base: string;
  quote: string;
  description: string;
  tokenA: `0x${string}`;
  tokenB: `0x${string}`;
};

function knownPairs(): PairRow[] {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (!d || !d.etx || d.etx === ZERO) return [];
  const rows: PairRow[] = [];
  if (ext?.eti && ext.eti !== ZERO) {
    rows.push({
      pair: 'ETI / ETX',
      base: 'ETI',
      quote: 'ETX',
      description: 'Etica token market routed through ETX.',
      tokenA: ext.eti,
      tokenB: d.etx,
    });
  }
  if (d.wegaz && d.wegaz !== ZERO) {
    rows.push({
      pair: 'WEGAZ / ETX',
      base: 'WEGAZ',
      quote: 'ETX',
      description: 'Wrapped gas market for EticaHub routing.',
      tokenA: d.wegaz,
      tokenB: d.etx,
    });
  }
  if (d.stakedETX && d.stakedETX !== ZERO) {
    rows.push({
      pair: 'stETX / ETX',
      base: 'stETX',
      quote: 'ETX',
      description: 'Liquid staking market surface for yield-bearing ETX.',
      tokenA: d.stakedETX,
      tokenB: d.etx,
    });
  }
  return rows;
}

async function resolvePairAddresses(
  rows: PairRow[],
): Promise<{ row: PairRow; pair: `0x${string}` | null }[]> {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  if (!d || !d.swapFactory || d.swapFactory === ZERO) {
    return rows.map((row) => ({ row, pair: null }));
  }
  const client = explorerClient();
  return Promise.all(
    rows.map(async (row) => {
      try {
        const pair = (await client.readContract({
          abi: abis.factoryAbi,
          address: d.swapFactory,
          functionName: 'getPair',
          args: [row.tokenA, row.tokenB],
        })) as `0x${string}`;
        return { row, pair: pair && pair !== ZERO ? pair : null };
      } catch {
        return { row, pair: null };
      }
    }),
  );
}

export default async function PairsPage() {
  const rows = knownPairs();
  const resolved = await resolvePairAddresses(rows);
  const tracked = resolved.filter((r) => r.pair !== null);
  const primary = tracked[0];

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
            On-chain pair analytics for EticaHub markets. Candles are derived live from the
            EticaSwap V2 Sync event log — no off-chain indexer required.
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
          {resolved.map(({ row, pair }) => (
            <div key={row.pair} className="grid grid-cols-[1fr_0.7fr_0.7fr] gap-3 px-4 py-4 text-sm md:grid-cols-[0.8fr_0.6fr_0.6fr_1.2fr_0.5fr] md:items-center">
              <div className="font-semibold text-brand-accent">{row.pair}</div>
              <div className="font-mono text-white/75">{row.base}</div>
              <div className="font-mono text-white/75">{row.quote}</div>
              <div className="hidden text-xs text-white/45 md:block">{row.description}</div>
              <div className="text-right">
                <span className={`rounded-full border px-2 py-1 text-[11px] ${pair ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>
                  {pair ? 'tracked' : 'pending'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {primary && primary.pair ? (
        <BrandCandleChartCard
          pair={primary.pair}
          eyebrow="Pair analytics"
          title={`${primary.row.pair} market`}
          subtitle="On-chain OHLC with crosshair tooltip. Pick an interval to slice the history."
          baseSymbol={primary.row.base}
          quoteSymbol={primary.row.quote}
          footer={
            <div className="grid border-t border-white/10 md:grid-cols-3">
              <DepthCard label="Buy depth" value="$42.8k" tone="green" />
              <DepthCard label="Sell depth" value="$31.4k" tone="red" />
              <DepthCard label="Spread" value="0.42%" tone="neutral" />
            </div>
          }
        />
      ) : null}
    </div>
  );
}

function DepthCard({ label, value, tone }: { label: string; value: string; tone: 'green' | 'red' | 'neutral' }) {
  const color = tone === 'green' ? 'text-emerald-300' : tone === 'red' ? 'text-rose-300' : 'text-white';
  return (
    <div className="border-white/10 px-4 py-3 md:border-r last:md:border-r-0">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
