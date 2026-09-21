/**
 * Server-side market snapshot shared by the indexable /tokens and /pools
 * pages. One RPC round for reserves + one NonKYC call for the USD anchor,
 * then everything else is derived in memory.
 */

import { getAddress, isAddress, type Address } from 'viem';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES } from '@etica-hub/shared';

import { fetchUsdAnchors } from '@/lib/buybot/oracle';
import { fetchAnchorEtxUsd } from '@/lib/buybot/scan';
import {
  apiTokens,
  fetchAllPairs,
  priceClient,
  priceVia,
  spotPriceFromReserves,
  tokenByAddress,
  tokenById,
  type ApiPairRaw,
  type ApiToken,
} from '@/lib/priceApi';

const MAINNET_CHAIN_ID = 61803;

export const TOKEN_IDS = ['etx', 'eti', 'egaz', 'wegaz', 'stetx'] as const;
export type TokenId = (typeof TOKEN_IDS)[number];

export function isTokenId(id: string): id is TokenId {
  return (TOKEN_IDS as readonly string[]).includes(id);
}

/** Editorial copy per token — static so the page has real text to index. */
export const TOKEN_COPY: Record<TokenId, { tagline: string; about: string }> = {
  etx: {
    tagline: 'EticaHub hub token',
    about:
      'ETX is the routing, fee and rewards token of EticaHub on the Etica mainnet. Every EticaSwap pool is paired against ETX, protocol fees are harvested into ETX buybacks, and ETX can be staked as stETX to earn a share of DEX revenue.',
  },
  eti: {
    tagline: 'Etica protocol token',
    about:
      'ETI is the native reward token of the Etica protocol — an open, decentralised medical-research network where miners are paid for peer-reviewed proposals. On EticaHub it trades against ETX and anchors USD pricing for the ecosystem.',
  },
  egaz: {
    tagline: 'Etica mainnet gas coin',
    about:
      'EGAZ is the native coin of the Etica blockchain (chain id 61803), used to pay for gas. It can be wrapped 1:1 into WEGAZ to trade on EticaSwap or bridged via the EticaHub bridge.',
  },
  wegaz: {
    tagline: 'Wrapped Etica gas',
    about:
      'WEGAZ is the canonical ERC-20 wrapper for EGAZ, redeemable 1:1. It lets the native gas coin be used in EticaSwap pools, farms and smart-contract integrations.',
  },
  stetx: {
    tagline: 'Staked ETX (ERC-4626)',
    about:
      'stETX is the yield-bearing ERC-4626 share token you receive when staking ETX on EticaHub. Its ETX redemption value rises as protocol revenue is harvested into the vault; it also trades against ETX in a low-slippage stableswap.',
  },
};

export interface TokenSnapshot {
  token: ApiToken;
  priceEtx: number | null;
  priceEti: number | null;
  priceUsd: number | null;
  pools: PoolSnapshot[];
}

export interface PoolSnapshot {
  address: Address;
  token0: ApiToken;
  token1: ApiToken;
  reserve0: number;
  reserve1: number;
  /** price of token0 in token1 */
  price0In1: number | null;
  /** price of token1 in token0 */
  price1In0: number | null;
  tvlEtx: number | null;
  tvlUsd: number | null;
  lpSupply: number;
  lastSyncTs: number;
}

export interface MarketSnapshot {
  asOf: string;
  etxUsd: number | null;
  tokens: TokenSnapshot[];
  pools: PoolSnapshot[];
}

function toUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Pairs whose both tokens are in the token registry; index, detail and sitemap all use this. */
export function isSupportedPair(p: ApiPairRaw): boolean {
  return tokenByAddress(p.token0) !== null && tokenByAddress(p.token1) !== null;
}

function poolSnapshot(p: ApiPairRaw, pairs: ApiPairRaw[], etxUsd: number | null): PoolSnapshot | null {
  const t0 = tokenByAddress(p.token0);
  const t1 = tokenByAddress(p.token1);
  const etx = tokenById('etx');
  if (!t0 || !t1 || !etx) return null;
  const r0 = toUnits(p.reserve0, t0.decimals);
  const r1 = toUnits(p.reserve1, t1.decimals);
  const p0 = priceVia(pairs, t0, etx);
  const p1 = priceVia(pairs, t1, etx);
  const tvlEtx = p0 !== null && p1 !== null ? r0 * p0 + r1 * p1 : null;
  return {
    address: getAddress(p.address),
    token0: t0,
    token1: t1,
    reserve0: r0,
    reserve1: r1,
    price0In1: spotPriceFromReserves(p, t0, t1),
    price1In0: spotPriceFromReserves(p, t1, t0),
    tvlEtx,
    tvlUsd: tvlEtx !== null && etxUsd !== null ? tvlEtx * etxUsd : null,
    lpSupply: toUnits(p.totalSupply, 18),
    lastSyncTs: p.blockTimestampLast,
  };
}

export async function loadMarketSnapshot(): Promise<MarketSnapshot> {
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (!d || !ext) throw new Error('mainnet deployments unavailable');

  const client = priceClient();
  const [pairs, anchors] = await Promise.all([
    fetchAllPairs(client),
    fetchUsdAnchors({ nonkycApiUrl: 'https://api.nonkyc.io' }).catch(() => ({ etiUsd: null, egazUsd: null })),
  ]);
  const etxUsd = await fetchAnchorEtxUsd(client, {
    factory: d.swapFactory,
    etx: d.etx,
    eti: ext.eti,
    wegaz: d.wegaz,
    anchors,
  }).catch(() => null);

  const pools = pairs
    .map((p) => poolSnapshot(p, pairs, etxUsd))
    .filter((p): p is PoolSnapshot => p !== null);

  const etx = tokenById('etx');
  const eti = tokenById('eti');
  const tokens: TokenSnapshot[] = apiTokens().map((token) => {
    const priceEtx = etx ? priceVia(pairs, token, etx) : null;
    const priceEti = eti ? priceVia(pairs, token, eti) : null;
    const addr = (token.address ?? token.wrappedAddress)?.toLowerCase();
    return {
      token,
      priceEtx,
      priceEti,
      priceUsd: priceEtx !== null && etxUsd !== null ? priceEtx * etxUsd : null,
      pools: pools.filter(
        (p) =>
          (p.token0.address ?? p.token0.wrappedAddress)?.toLowerCase() === addr ||
          (p.token1.address ?? p.token1.wrappedAddress)?.toLowerCase() === addr,
      ),
    };
  });

  return { asOf: new Date().toISOString(), etxUsd, tokens, pools };
}

export function findToken(snapshot: MarketSnapshot, id: string): TokenSnapshot | null {
  return snapshot.tokens.find((t) => t.token.id === id.toLowerCase()) ?? null;
}

export function findPool(snapshot: MarketSnapshot, address: string): PoolSnapshot | null {
  if (!isAddress(address, { strict: false })) return null;
  const want = getAddress(address);
  return snapshot.pools.find((p) => p.address === want) ?? null;
}

export function poolName(p: PoolSnapshot): string {
  return `${p.token0.symbol}/${p.token1.symbol}`;
}

export function poolPath(p: PoolSnapshot): string {
  return `/pools/${p.address}`;
}

export function tokenPath(t: ApiToken): string {
  return `/tokens/${t.id}`;
}

export function fmtNum(n: number | null, maxFrac = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n !== 0 && Math.abs(n) < 0.01) return n.toPrecision(3);
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

export function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toPrecision(3)}`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
