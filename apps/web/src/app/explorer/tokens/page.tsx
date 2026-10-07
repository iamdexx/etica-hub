import Link from 'next/link';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis, type FrozenHolder } from '@etica-hub/shared';
import { explorerClient, shortAddress } from '@/lib/explorer';
import {
  formatSupply,
  readErc20Supply,
  readNativeSupply,
  toUnits,
  type SupplyBreakdown,
} from '@/lib/supply';
import { BrandCandleChartCard } from '@/components/BrandCandleChartCard';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
const ZERO = '0x0000000000000000000000000000000000000000';

type AssetRow = {
  symbol: string;
  name: string;
  /** `null` for the native coin — it has no contract. */
  address: `0x${string}` | null;
  type: string;
  description: string;
  /** Total is a lower bound (emission floor) rather than an exact contract read. */
  totalIsFloor?: boolean;
};

type ResolvedRow = AssetRow & {
  decimals: number;
  supply: SupplyBreakdown;
  deployed: boolean;
};

function knownAssets(): AssetRow[] {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  return [
    {
      symbol: 'EGAZ',
      name: 'Etica Gas',
      address: null,
      type: 'Native coin',
      description: 'The chain\u2019s native coin: pays gas and is emitted at 2 EGAZ per mined block.',
      totalIsFloor: true,
    },
    ext?.eti && ext.eti !== ZERO
      ? { symbol: 'ETI', name: 'Etica', address: ext.eti, type: 'ERC-20 · protocol', description: 'Etica protocol token, mined with RandomX and paid out for approved research.' }
      : null,
    d?.etx && d.etx !== ZERO
      ? { symbol: 'ETX', name: 'EticaHub Token', address: d.etx, type: 'ERC-20', description: 'EticaHub routing, rewards, and ecosystem asset.' }
      : null,
    d?.wegaz && d.wegaz !== ZERO
      ? { symbol: 'WEGAZ', name: 'Wrapped EGAZ', address: d.wegaz, type: 'Wrapped ERC-20', description: 'ERC-20 wrapper around native EGAZ so it can trade in EticaSwap pairs; 1:1 redeemable.' }
      : null,
  ].filter(Boolean) as AssetRow[];
}

async function resolveRow(
  client: ReturnType<typeof explorerClient>,
  row: AssetRow,
  head: bigint,
  frozenHolders: FrozenHolder[],
): Promise<ResolvedRow> {
  if (!row.address) {
    const supply = await readNativeSupply(client, head, frozenHolders);
    return { ...row, decimals: 18, supply, deployed: head > 0n };
  }
  const address = row.address;
  const [symbol, name, decimals, supply, code] = await Promise.all([
    client.readContract({ abi: abis.erc20Abi, address, functionName: 'symbol' }).catch(() => row.symbol),
    client.readContract({ abi: abis.erc20Abi, address, functionName: 'name' }).catch(() => row.name),
    client.readContract({ abi: abis.erc20Abi, address, functionName: 'decimals' }).catch(() => 18),
    readErc20Supply(client, address, frozenHolders),
    client.getCode({ address }).catch(() => undefined),
  ]);
  return {
    ...row,
    symbol: String(symbol || row.symbol),
    name: String(name || row.name),
    decimals: Number(decimals || 18),
    supply,
    deployed: typeof code === 'string' && code !== '0x',
  };
}

async function resolveEtxPair(
  client: ReturnType<typeof explorerClient>,
  tokenAddress: `0x${string}`,
): Promise<`0x${string}` | null> {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  if (!d || !d.swapFactory || d.swapFactory === ZERO) return null;
  if (!d.etx || d.etx === ZERO) return null;
  if (tokenAddress.toLowerCase() === d.etx.toLowerCase()) return null;
  try {
    const pair = (await client.readContract({
      abi: abis.factoryAbi,
      address: d.swapFactory,
      functionName: 'getPair',
      args: [tokenAddress, d.etx],
    })) as `0x${string}`;
    return pair && pair !== ZERO ? pair : null;
  } catch {
    return null;
  }
}

function supplyText(row: ResolvedRow, value: bigint): string {
  const text = formatSupply(toUnits(value, row.decimals));
  return row.totalIsFloor && text !== '—' ? `≥ ${text}` : text;
}

export default async function TokensPage() {
  const client = explorerClient();
  const frozenHolders = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID]?.frozenHolders ?? [];
  const head = await client.getBlockNumber().catch(() => 0n);
  const rows = await Promise.all(knownAssets().map((row) => resolveRow(client, row, head, frozenHolders)));
  // Headline chart: the ETI/ETX market. Fall back to any other ERC-20 with an
  // ETX pair if ETI isn't configured on this chain.
  const primary =
    rows.find((r) => r.symbol === 'ETI' && r.address) ??
    rows.find((r) => r.address && r.symbol !== 'ETX');
  const primaryPair = primary?.address ? await resolveEtxPair(client, primary.address) : null;
  const frozenRows = rows.filter((r) => r.supply.frozen > 0n);

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
            Native EGAZ plus the ERC-20 assets EticaHub tracks, read live from public RPC.
            Circulating supply nets out balances frozen at protocol level; the headline chart
            is the ETI/ETX market derived from on-chain Sync events.
          </p>
        </div>

        <div className="grid grid-cols-[0.8fr_1fr_0.8fr] gap-3 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[0.7fr_1fr_0.9fr_0.7fr_0.7fr_0.6fr]">
          <div>Asset</div>
          <div>Name</div>
          <div className="hidden md:block">Address</div>
          <div className="text-right">Circulating</div>
          <div className="hidden text-right md:block">Total</div>
          <div className="hidden text-right md:block">Status</div>
        </div>

        <div className="divide-y divide-white/5">
          {rows.map((row) => {
            const href = row.address ? `/explorer/address/${row.address}` : '/explorer/gas';
            return (
              <div key={row.symbol} className="grid grid-cols-[0.8fr_1fr_0.8fr] gap-3 px-4 py-4 text-sm md:grid-cols-[0.7fr_1fr_0.9fr_0.7fr_0.7fr_0.6fr] md:items-center">
                <div>
                  <Link href={href} className="font-semibold text-brand-accent hover:underline">{row.symbol}</Link>
                  <div className="mt-1 text-[11px] text-white/40">{row.type}</div>
                </div>
                <div>
                  <div className="text-white/85">{row.name}</div>
                  <div className="mt-1 text-xs text-white/45">{row.description}</div>
                </div>
                <div className="hidden font-mono text-xs text-white/55 md:block">
                  {row.address ? (
                    <Link href={href} className="hover:text-brand-accent hover:underline">{shortAddress(row.address)}</Link>
                  ) : (
                    <span className="text-white/35">native · no contract</span>
                  )}
                </div>
                <div className="text-right font-mono text-xs text-white/75">
                  <div>{supplyText(row, row.supply.circulating)}</div>
                  {row.supply.frozen > 0n ? (
                    <div className="mt-1 text-[10px] text-amber-200/70" title={row.supply.frozenBalances.map((f) => f.holder.reason).join('; ')}>
                      −{formatSupply(toUnits(row.supply.frozen, row.decimals))} frozen
                    </div>
                  ) : null}
                  <div className="mt-1 text-[10px] text-white/40 md:hidden">total {supplyText(row, row.supply.total)}</div>
                </div>
                <div className="hidden text-right font-mono text-xs text-white/55 md:block">{supplyText(row, row.supply.total)}</div>
                <div className="hidden text-right md:block">
                  <span className={`rounded-full border px-2 py-1 text-[11px] ${row.deployed ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>
                    {row.deployed ? 'Live' : 'Unavailable'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-1 border-t border-white/10 px-4 py-3 text-[11px] leading-5 text-white/45">
          <p>
            EGAZ has no supply contract: its total is the block-reward emission floor (2 EGAZ × blocks mined, ETIP-1017),
            which excludes the small extra paid for uncle blocks. Everything else is the live ERC-20 <span className="font-mono">totalSupply()</span>.
          </p>
          {frozenRows.length ? (
            <p>
              Frozen balances are held by{' '}
              {frozenHolders.map((h, i) => (
                <span key={h.address}>
                  {i > 0 ? ', ' : ''}
                  <Link href={`/explorer/address/${h.address}`} className="font-mono text-white/65 hover:underline">{shortAddress(h.address, 6)}</Link>
                  {' '}({h.label.replace(' (frozen)', '')})
                </span>
              ))}
              : {frozenHolders[0]?.reason}. The node rejects every transaction from these senders and the ETI contract reverts their transfers, so the funds are out of circulation.{' '}
              {frozenHolders[0] ? (
                <a href={frozenHolders[0].source} target="_blank" rel="noreferrer" className="underline decoration-white/30 hover:text-white/70">Hardfork notes ↗</a>
              ) : null}
            </p>
          ) : null}
        </div>
      </section>

      {primary && primaryPair ? (
        <BrandCandleChartCard
          pair={primaryPair}
          eyebrow="Token market"
          title={`${primary.symbol} / ETX market`}
          subtitle="Live OHLC derived from on-chain reserves. Circulating supply highlighted below."
          baseSymbol={primary.symbol}
          quoteSymbol="ETX"
          rightActions={
            <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-white/55">
              circulating {formatSupply(toUnits(primary.supply.circulating, primary.decimals))}
            </span>
          }
        />
      ) : null}
    </div>
  );
}
