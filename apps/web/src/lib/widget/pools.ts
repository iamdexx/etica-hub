import { unstable_cache } from 'next/cache';
import { parseAbi, type Address } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';
import { fetchAllV2Pairs, priceClient, tokenByAddress } from '@/lib/priceApi';
import { dedupeKeys, makeWidgetPool, type WidgetPool, type WidgetToken } from './poolKeys';

const metaAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

async function describeToken(address: Address): Promise<WidgetToken> {
  const d = DEPLOYMENTS[eticaMainnet.id];
  if (address.toLowerCase() === d.wegaz.toLowerCase()) return { address, symbol: 'EGAZ', decimals: 18, native: true };
  const known = tokenByAddress(address);
  if (known) return { address, symbol: known.symbol, decimals: known.decimals, native: false };
  // a pool someone created with a token we do not list: read its metadata on-chain
  const client = priceClient();
  const [symbol, decimals] = await Promise.all([
    client.readContract({ abi: metaAbi, address, functionName: 'symbol' }).catch(() => `${address.slice(0, 6)}…`),
    client.readContract({ abi: metaAbi, address, functionName: 'decimals' }).catch(() => 18),
  ]);
  return { address, symbol: String(symbol), decimals: Number(decimals), native: false };
}

async function load(): Promise<WidgetPool[]> {
  const pairs = await fetchAllV2Pairs();
  // keys are assigned in factory (creation) order so they never move between contracts
  const pools = dedupeKeys(
    await Promise.all(
      pairs.map(async (p) => makeWidgetPool(p.address, await describeToken(p.token0), await describeToken(p.token1))),
    ),
  );
  // seeded pools first for display; empty ones stay listed so their creator can seed them
  const seeded = new Set(pairs.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n).map((p) => p.address));
  return [...pools.filter((p) => seeded.has(p.address)), ...pools.filter((p) => !seeded.has(p.address))];
}

/**
 * Every pool on the standalone V2 factory, with user-facing token metadata,
 * cached for a minute so an embed page load does not fan out to the RPC.
 * Returns [] when the RPC is unreachable; the widget shows a retry note.
 */
export const listWidgetPools = unstable_cache(
  async (): Promise<WidgetPool[]> => {
    try {
      return await load();
    } catch {
      return [];
    }
  },
  ['widget-v2-pools'],
  { revalidate: 60 },
);
