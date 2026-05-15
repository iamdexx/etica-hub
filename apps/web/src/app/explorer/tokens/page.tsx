import Link from 'next/link';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';
import { explorerClient, shortAddress } from '@/lib/explorer';
import { MarketCandles, demoCandles } from '@/components/MarketCandles';
import { MarketChartShell, MarketPill, TimeframePills } from '@/components/MarketChartShell';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
const ZERO = '0x0000000000000000000000000000000000000000';

type TokenRow = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  type: string;
  description: string;
};

function knownTokens(): TokenRow[] {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  return [
    d?.etx && d.etx !== ZERO
      ? { symbol: 'ETX', name: 'EticaHub Token', address: d.etx, type: 'ERC-20', description: 'EticaHub routing, rewards, and ecosystem asset.' }
      : null,
    ext?.eti && ext.eti !== ZERO
      ? { symbol: 'ETI', name: 'Etica', address: ext.eti, type: 'ERC-20', description: 'Etica ecosystem token surfaced inside EticaHub.' }
      : null,
    d?.wegaz && d.wegaz !== ZERO
      ? { symbol: 'WEGAZ', name: 'Wrapped EGAZ', address: d.wegaz, type: 'Wrapped gas', description: 'Wrapped native gas asset for EticaHub pairs.' }
      : null,
  ].filter(Boolean) as TokenRow[];
}

async function readToken(client: ReturnType<typeof explorerClient>, token: TokenRow) {
  const [symbol, name, decimals, totalSupply, code] = await Promise.all([
    client.readContract({ abi: abis.erc20Abi, address: token.address, functionName: 'symbol' }).catch(() => token.symbol),
    client.readContract({ abi: abis.erc20Abi, address: token.address, functionName: 'name' }).catch(() => token.name),
    client.readContract({ abi: abis.erc20Abi, address: token.address, functionName: 'decimals' }).catch(() => 18),
    client.readContract({ abi: abis.erc20Abi, address: token.address, functionName: 'totalSupply' }).catch(() => 0n),
    client.getCode({ address: token.address }).catch(() => undefined),
  ]);

  const dec = Number(decimals || 18);
  const supply = Number(totalSupply) / 10 ** dec;
  return {
    ...token,
    symbol: String(symbol || token.symbol),
    name: String(name || token.name),
    decimals: dec,
    totalSupply: supply,
    deployed: typeof code === 'string' && code !== '0x',
  };
}

function formatSupply(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default async function TokensPage() {
  const client = explorerClient();
  const rows = await Promise.all(knownTokens().map((token) => readToken(client, token)));
  const primary = rows[0];

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">Explorer</Link>
        <span className="px-1">/</span>
        <span>Tokens</span>
      </nav>

      <section className="overflow-hidden rounded-xl border border-white/10 bg-[#07120f]">
        <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.16),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] p-6">
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/75">EticaHub Scan · Assets</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">Tokens</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
            Public-RPC-safe token registry for EticaHub assets with lightweight market terminal visuals. Full historical candles can be swapped in once an indexer is online.
          </p>
        </div>

        <div className="grid grid-cols-[0.8fr_1fr_0.7fr] gap-3 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[0.7fr_1fr_1fr_0.7fr_0.7fr]">
          <div>Token</div>
          <div>Name</div>
          <div className="hidden md:block">Address</div>
          <div className="text-right">Supply</div>
          <div className="hidden text-right md:block">Status</div>
        </div>

        <div className="divide-y divide-white/5">
          {rows.map((row) => (
            <div key={row.address} className="grid grid-cols-[0.8fr_1fr_0.7fr] gap-3 px-4 py-4 text-sm md:grid-cols-[0.7fr_1fr_1fr_0.7fr_0.7fr] md:items-center">
              <div>
                <Link href={`/explorer/address/${row.address}`} className="font-semibold text-brand-accent hover:underline">{row.symbol}</Link>
                <div className="mt-1 text-[11px] text-white/40">{row.type}</div>
              </div>
              <div>
                <div className="text-white/85">{row.name}</div>
                <div className="mt-1 text-xs text-white/45">{row.description}</div>
              </div>
              <div className="hidden font-mono text-xs text-white/55 md:block">
                <Link href={`/explorer/address/${row.address}`} className="hover:text-brand-accent hover:underline">{shortAddress(row.address)}</Link>
              </div>
              <div className="text-right font-mono text-xs text-white/75">{formatSupply(row.totalSupply)}</div>
              <div className="hidden text-right md:block">
                <span className={`rounded-full border px-2 py-1 text-[11px] ${row.deployed ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>
                  {row.deployed ? 'Live' : 'Unavailable'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {primary ? (
        <MarketChartShell
          eyebrow="Token market"
          title={`${primary.symbol} / ETX market structure`}
          subtitle="Lightweight TradingView-style surface ready for indexed OHLC data."
          actions={
            <>
              <TimeframePills active="24H" />
              <MarketPill tone="green">{primary.symbol}</MarketPill>
              <MarketPill>supply {formatSupply(primary.totalSupply)}</MarketPill>
            </>
          }
        >
          <MarketCandles candles={demoCandles(primary.symbol.length)} />
        </MarketChartShell>
      ) : null}
    </div>
  );
}
