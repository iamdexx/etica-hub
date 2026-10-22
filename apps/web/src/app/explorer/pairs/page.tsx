import Link from 'next/link';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';
import { BrandCandleChartCard } from '@/components/BrandCandleChartCard';
import { explorerClient } from '@/lib/explorer';
import { fetchAllDirectWindows } from '@/lib/priceApi';
import { formatTokenAmount, resolveTokenInfos } from '@/lib/token';

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
      pair: 'EGAZ / ETX',
      base: 'EGAZ',
      quote: 'ETX',
      description: 'Gas coin market for EticaHub routing (pool holds EGAZ in ERC-20 form).',
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

type DirectRow = {
  pair: `0x${string}`;
  base: string;
  quote: string;
  reserve0: string;
  reserve1: string;
};

async function directWindows(): Promise<DirectRow[]> {
  try {
    const client = explorerClient();
    const windows = await fetchAllDirectWindows(client);
    if (windows.length === 0) return [];
    const infos = await resolveTokenInfos(
      client,
      windows.flatMap((w) => [w.token0, w.token1]),
    );
    return windows.map((w) => {
      const t0 = infos.get(w.token0.toLowerCase());
      const t1 = infos.get(w.token1.toLowerCase());
      return {
        pair: w.address,
        base: t0?.symbol ?? 'token0',
        quote: t1?.symbol ?? 'token1',
        reserve0: formatTokenAmount(w.reserve0, t0?.decimals ?? 18),
        reserve1: formatTokenAmount(w.reserve1, t1?.decimals ?? 18),
      };
    });
  } catch {
    return [];
  }
}

export default async function PairsPage() {
  const rows = knownPairs();
  const [resolved, direct] = await Promise.all([resolvePairAddresses(rows), directWindows()]);
  const tracked = resolved.filter((r) => r.pair !== null);
  const primary = tracked[0];

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">Explorer</Link>
        <span className="px-1">/</span>
        <span>Pairs</span>
      </nav>

      <section className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#07120f]">
        <div className="border-b border-white/[0.07] bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.16),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] p-6">
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/75">EticaHub Scan · Markets</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">Pairs</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
            On-chain pair analytics for EticaHub markets. Candles are derived live from the
            EticaSwap V2 Sync event log — no off-chain indexer required.
          </p>
        </div>

        <div className="grid grid-cols-[1fr_0.7fr_0.7fr] gap-3 border-b border-white/[0.07] px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[0.8fr_0.6fr_0.6fr_1.2fr_0.5fr]">
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

      <section className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#07120f]">
        <div className="border-b border-white/[0.07] p-6">
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/75">EticaSwap Direct · V5</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Direct windows</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
            Dollar and cross markets backed by the ETX hub. A window holds no tokens of its own: its
            liquidity is hub LP and every swap settles on the hub pools. The reserves below are the
            hub-backed view (token0 / token1 / getReserves) that trackers read.
          </p>
        </div>
        <div className="grid grid-cols-[1fr_1fr] gap-3 border-b border-white/[0.07] px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[0.8fr_1fr_1fr_1.4fr]">
          <div>Pair</div>
          <div>Reserve base</div>
          <div>Reserve quote</div>
          <div className="hidden md:block">Window</div>
        </div>
        <div className="divide-y divide-white/5">
          {direct.length === 0 ? (
            <div className="px-4 py-4 text-sm text-white/45">No Direct windows open yet.</div>
          ) : (
            direct.map((w) => (
              <div
                key={w.pair}
                className="grid grid-cols-[1fr_1fr] gap-3 px-4 py-4 text-sm md:grid-cols-[0.8fr_1fr_1fr_1.4fr] md:items-center"
              >
                <div className="font-semibold text-brand-accent">
                  {w.base} / {w.quote}
                </div>
                <div className="font-mono text-white/75">
                  {w.reserve0} {w.base}
                </div>
                <div className="font-mono text-white/75">
                  {w.reserve1} {w.quote}
                </div>
                <div className="hidden md:block">
                  <Link
                    href={`/explorer/address/${w.pair}`}
                    className="break-all font-mono text-xs text-emerald-300 hover:underline"
                  >
                    {w.pair}
                  </Link>
                </div>
              </div>
            ))
          )}
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
            <div className="grid border-t border-white/[0.07] md:grid-cols-3">
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
    <div className="border-white/[0.07] px-4 py-3 md:border-r last:md:border-r-0">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
