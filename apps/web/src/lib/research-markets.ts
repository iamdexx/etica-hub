/**
 * Browser-side helpers for the EticaResearchMarkets launchpad — fetches all
 * markets registered on the singleton, joins per-market state with the
 * deployed ResearchToken's on-chain metadata, classifies each market into
 * one of four UI buckets (Live / Pending graduation / Graduated / Sunset),
 * and exposes a single `useResearchMarkets()` hook for the launchpad UI.
 *
 * Reads are batched via wagmi's `useReadContracts` (multicall) so the page
 * cost is one round-trip per stage regardless of how many tokens are
 * registered. Cheap enough for v1; we can swap in an indexer later.
 */
'use client';

import { useMemo } from 'react';
import { useChainId, useReadContract, useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import {
  DEPLOYMENTS,
  abis,
  isSupportedChainId,
} from '@etica-hub/shared';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export type MarketStatus = 'live' | 'pending' | 'graduated' | 'sunset';

export type MarketView = {
  token: Address;
  researcher: Address;
  virtualEtxStart: bigint;
  virtualEtxAcc: bigint;
  tokenSupply: bigint;
  virtualTokenStart: bigint;
  launchedAt: bigint;
  lastTradeAt: bigint;
  graduatedAt: bigint;
  sunsetted: boolean;
};

export type ResearchMarket = {
  token: Address;
  researcher: Address;
  name: string;
  symbol: string;
  imageURI: string;
  description: string;
  website: string;
  telegram: string;
  xUrl: string;
  evidenceURI: string;
  virtualEtxStart: bigint;
  virtualEtxAcc: bigint;
  tokenSupply: bigint;
  virtualTokenStart: bigint;
  launchedAt: bigint;
  lastTradeAt: bigint;
  graduatedAt: bigint;
  sunsetted: boolean;
  status: MarketStatus;
};

/**
 * Returns the EticaResearchMarkets singleton address on the connected chain,
 * or null if the user is on an unsupported chain or the singleton has not
 * been deployed yet (placeholder zero address in `addresses.ts`).
 */
export function useResearchMarketsAddress(): Address | null {
  const chainId = useChainId();
  return useMemo(() => {
    if (!isSupportedChainId(chainId)) return null;
    const addr = DEPLOYMENTS[chainId].eticaResearchMarkets;
    if (!addr || addr === ZERO) return null;
    return addr;
  }, [chainId]);
}

/**
 * Reads the singleton's tunable parameters (graduation threshold, sunset
 * window, fee rate, launch toll, etc.) — used by the launchpad UI to display
 * thresholds and pre-populate the launch form.
 */
export function useResearchMarketsConfig() {
  const market = useResearchMarketsAddress();
  const enabled = market !== null;

  const { data, isLoading } = useReadContracts({
    contracts: enabled
      ? ([
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'graduationThreshold' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'sunsetWindow' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'feeRateBps' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'launchTollEtx' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'etiLpBps' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'treasuryBps' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'researcherBps' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'defaultVirtualEtxStart' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'defaultVirtualTokenStart' },
          { address: market, abi: abis.eticaResearchMarketsAbi, functionName: 'totalMarkets' },
        ] as const)
      : [],
    query: { enabled, refetchInterval: 30_000 },
  });

  return useMemo(() => {
    if (!data) return null;
    const get = <T,>(i: number): T | null =>
      data[i]?.status === 'success' ? (data[i]!.result as T) : null;
    return {
      graduationThreshold: get<bigint>(0) ?? 0n,
      sunsetWindow: get<bigint>(1) ?? 0n,
      feeRateBps: Number(get<bigint>(2) ?? 0n),
      launchTollEtx: get<bigint>(3) ?? 0n,
      etiLpBps: Number(get<bigint>(4) ?? 0n),
      treasuryBps: Number(get<bigint>(5) ?? 0n),
      researcherBps: Number(get<bigint>(6) ?? 0n),
      defaultVirtualEtxStart: get<bigint>(7) ?? 0n,
      defaultVirtualTokenStart: get<bigint>(8) ?? 0n,
      totalMarkets: Number(get<bigint>(9) ?? 0n),
      isLoading,
    };
  }, [data, isLoading]);
}

/**
 * Lists every market token address registered on the singleton. Walks
 * `marketAt(i)` for i in [0, totalMarkets). One multicall.
 */
function useMarketAddresses(total: number): Address[] {
  const market = useResearchMarketsAddress();
  const { data } = useReadContracts({
    contracts:
      market && total > 0
        ? Array.from({ length: total }, (_, i) => ({
            address: market,
            abi: abis.eticaResearchMarketsAbi,
            functionName: 'marketAt' as const,
            args: [BigInt(i)] as const,
          }))
        : [],
    query: { enabled: market !== null && total > 0, refetchInterval: 30_000 },
  });

  return useMemo(() => {
    if (!data) return [];
    return data
      .filter((r) => r.status === 'success' && r.result)
      .map((r) => r.result as Address);
  }, [data]);
}

/**
 * Reads the full `MarketView` for every passed-in token address in one
 * multicall, returning a typed list (zero-results are dropped).
 */
function useMarketStructs(tokens: Address[]): MarketView[] {
  const market = useResearchMarketsAddress();
  const { data } = useReadContracts({
    contracts:
      market && tokens.length > 0
        ? tokens.map(
            (t) =>
              ({
                address: market,
                abi: abis.eticaResearchMarketsAbi,
                functionName: 'market' as const,
                args: [t] as const,
              }) as const,
          )
        : [],
    query: { enabled: market !== null && tokens.length > 0, refetchInterval: 15_000 },
  });

  return useMemo(() => {
    if (!data) return [];
    return data
      .map((r): MarketView | null => {
        if (r.status !== 'success' || !r.result) return null;
        const m = r.result as {
          token: Address;
          researcher: Address;
          virtualEtxStart: bigint;
          virtualEtxAcc: bigint;
          tokenSupply: bigint;
          virtualTokenStart: bigint;
          launchedAt: bigint;
          lastTradeAt: bigint;
          graduatedAt: bigint;
          sunsetted: boolean;
        };
        return {
          token: m.token,
          researcher: m.researcher,
          virtualEtxStart: BigInt(m.virtualEtxStart),
          virtualEtxAcc: BigInt(m.virtualEtxAcc),
          tokenSupply: BigInt(m.tokenSupply),
          virtualTokenStart: BigInt(m.virtualTokenStart),
          launchedAt: BigInt(m.launchedAt),
          lastTradeAt: BigInt(m.lastTradeAt),
          graduatedAt: BigInt(m.graduatedAt),
          sunsetted: m.sunsetted,
        };
      })
      .filter((m): m is MarketView => m !== null);
  }, [data]);
}

/**
 * Reads the per-token metadata strings (name, symbol, imageURI,
 * description, website, telegram, xUrl, evidenceURI) for every passed-in
 * token. One multicall with 8N calls.
 */
function useTokenMetadata(tokens: Address[]) {
  const { data } = useReadContracts({
    contracts: tokens.flatMap((t) => [
      { address: t, abi: abis.researchTokenAbi, functionName: 'name' as const },
      { address: t, abi: abis.researchTokenAbi, functionName: 'symbol' as const },
      { address: t, abi: abis.researchTokenAbi, functionName: 'imageURI' as const },
      { address: t, abi: abis.researchTokenAbi, functionName: 'description' as const },
      { address: t, abi: abis.researchTokenAbi, functionName: 'website' as const },
      { address: t, abi: abis.researchTokenAbi, functionName: 'telegram' as const },
      { address: t, abi: abis.researchTokenAbi, functionName: 'xUrl' as const },
      { address: t, abi: abis.researchTokenAbi, functionName: 'evidenceURI' as const },
    ]),
    query: { enabled: tokens.length > 0, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    if (!data) return new Map<Address, ResearchMarket['name'] | string>();
    const out = new Map<
      Address,
      {
        name: string;
        symbol: string;
        imageURI: string;
        description: string;
        website: string;
        telegram: string;
        xUrl: string;
        evidenceURI: string;
      }
    >();
    tokens.forEach((t, i) => {
      const base = i * 8;
      const safe = (k: number): string => {
        const r = data[base + k];
        return r && r.status === 'success' && typeof r.result === 'string' ? r.result : '';
      };
      out.set(t, {
        name: safe(0),
        symbol: safe(1),
        imageURI: safe(2),
        description: safe(3),
        website: safe(4),
        telegram: safe(5),
        xUrl: safe(6),
        evidenceURI: safe(7),
      });
    });
    return out;
  }, [data, tokens]);
}

/**
 * Status classifier — mirrors the singleton's own semantics:
 *   - sunset:     `MarketView.sunsetted == true`
 *   - graduated:  `graduatedAt > 0`
 *   - pending:    `virtualEtxAcc >= 80% of graduationThreshold` (and not yet graduated)
 *   - live:       everything else
 *
 * The "pending" bucket is purely a UI affordance; the singleton itself only
 * tracks "graduated" / "sunsetted" / neither. We surface near-threshold
 * markets to help degens find what's about to graduate next.
 */
function classify(m: MarketView, graduationThreshold: bigint): MarketStatus {
  if (m.sunsetted) return 'sunset';
  if (m.graduatedAt > 0n) return 'graduated';
  if (graduationThreshold > 0n && m.virtualEtxAcc * 10n >= graduationThreshold * 8n) {
    return 'pending';
  }
  return 'live';
}

/**
 * Top-level hook for the launchpad. Returns the full list of markets
 * (joined with on-chain token metadata + UI status bucket), plus a
 * `byStatus` map for tab rendering. Cheap: 2-3 multicalls regardless of
 * market count, with 30s refetch.
 */
export function useResearchMarkets(): {
  markets: ResearchMarket[];
  byStatus: Record<MarketStatus, ResearchMarket[]>;
  graduationThreshold: bigint;
  sunsetWindow: bigint;
  isLoading: boolean;
} {
  const config = useResearchMarketsConfig();
  const total = config?.totalMarkets ?? 0;
  const addresses = useMarketAddresses(total);
  const structs = useMarketStructs(addresses);
  const metadata = useTokenMetadata(addresses);

  return useMemo(() => {
    const graduationThreshold = config?.graduationThreshold ?? 0n;
    const sunsetWindow = config?.sunsetWindow ?? 0n;

    const markets: ResearchMarket[] = structs.map((s) => {
      const md = metadata.get(s.token) as
        | {
            name: string;
            symbol: string;
            imageURI: string;
            description: string;
            website: string;
            telegram: string;
            xUrl: string;
            evidenceURI: string;
          }
        | undefined;
      return {
        token: s.token,
        researcher: s.researcher,
        name: md?.name ?? '',
        symbol: md?.symbol ?? '',
        imageURI: md?.imageURI ?? '',
        description: md?.description ?? '',
        website: md?.website ?? '',
        telegram: md?.telegram ?? '',
        xUrl: md?.xUrl ?? '',
        evidenceURI: md?.evidenceURI ?? '',
        virtualEtxStart: s.virtualEtxStart,
        virtualEtxAcc: s.virtualEtxAcc,
        tokenSupply: s.tokenSupply,
        virtualTokenStart: s.virtualTokenStart,
        launchedAt: s.launchedAt,
        lastTradeAt: s.lastTradeAt,
        graduatedAt: s.graduatedAt,
        sunsetted: s.sunsetted,
        status: classify(s, graduationThreshold),
      };
    });

    const byStatus: Record<MarketStatus, ResearchMarket[]> = {
      live: [],
      pending: [],
      graduated: [],
      sunset: [],
    };
    for (const m of markets) byStatus[m.status].push(m);

    // Pending bucket: closest to graduation first (highest accumulated reserve)
    byStatus.pending.sort((a, b) => Number(b.virtualEtxAcc - a.virtualEtxAcc));
    // Live: newest first
    byStatus.live.sort((a, b) => Number(b.launchedAt - a.launchedAt));
    // Graduated: most recent graduation first
    byStatus.graduated.sort((a, b) => Number(b.graduatedAt - a.graduatedAt));
    // Sunset: most recently sunset/dormant first
    byStatus.sunset.sort((a, b) => Number(b.lastTradeAt - a.lastTradeAt));

    return {
      markets,
      byStatus,
      graduationThreshold,
      sunsetWindow,
      isLoading: !!config?.isLoading,
    };
  }, [config, structs, metadata]);
}

/**
 * Single-market lookup for the detail page. Hits the singleton's `market()`
 * view and the token's metadata reads independently. Returns null while
 * loading or if the token isn't registered.
 */
export function useResearchMarket(token: Address | undefined): ResearchMarket | null {
  const market = useResearchMarketsAddress();
  const config = useResearchMarketsConfig();

  const { data: m } = useReadContract({
    address: market ?? undefined,
    abi: abis.eticaResearchMarketsAbi,
    functionName: 'market',
    args: token ? [token] : undefined,
    query: { enabled: market !== null && !!token, refetchInterval: 15_000 },
  });

  const { data: meta } = useReadContracts({
    contracts: token
      ? ([
          { address: token, abi: abis.researchTokenAbi, functionName: 'name' as const },
          { address: token, abi: abis.researchTokenAbi, functionName: 'symbol' as const },
          { address: token, abi: abis.researchTokenAbi, functionName: 'imageURI' as const },
          { address: token, abi: abis.researchTokenAbi, functionName: 'description' as const },
          { address: token, abi: abis.researchTokenAbi, functionName: 'website' as const },
          { address: token, abi: abis.researchTokenAbi, functionName: 'telegram' as const },
          { address: token, abi: abis.researchTokenAbi, functionName: 'xUrl' as const },
          { address: token, abi: abis.researchTokenAbi, functionName: 'evidenceURI' as const },
        ] as const)
      : [],
    query: { enabled: !!token, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    if (!m || !meta || !token) return null;
    const safe = (k: number): string => {
      const r = meta[k];
      return r && r.status === 'success' && typeof r.result === 'string' ? r.result : '';
    };
    const view = m as MarketView;
    if (view.token === ZERO) return null;
    return {
      token: view.token,
      researcher: view.researcher,
      name: safe(0),
      symbol: safe(1),
      imageURI: safe(2),
      description: safe(3),
      website: safe(4),
      telegram: safe(5),
      xUrl: safe(6),
      evidenceURI: safe(7),
      virtualEtxStart: BigInt(view.virtualEtxStart),
      virtualEtxAcc: BigInt(view.virtualEtxAcc),
      tokenSupply: BigInt(view.tokenSupply),
      virtualTokenStart: BigInt(view.virtualTokenStart),
      launchedAt: BigInt(view.launchedAt),
      lastTradeAt: BigInt(view.lastTradeAt),
      graduatedAt: BigInt(view.graduatedAt),
      sunsetted: view.sunsetted,
      status: classify(view, config?.graduationThreshold ?? 0n),
    };
  }, [m, meta, token, config]);
}

/**
 * Converts a possibly-`ipfs://...` URI to an HTTP gateway URL the browser
 * can render. Falls through unchanged for `http(s)://` URIs.
 */
export function resolveImageURI(uri: string): string {
  if (!uri) return '';
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  }
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return uri;
  }
  return '';
}

/**
 * Pretty progress (0-100) of a market toward UI-only graduation.
 */
export function graduationProgress(m: ResearchMarket, threshold: bigint): number {
  if (threshold === 0n) return 0;
  if (m.virtualEtxAcc >= threshold) return 100;
  return Number((m.virtualEtxAcc * 10000n) / threshold) / 100;
}
