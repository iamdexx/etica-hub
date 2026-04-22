/**
 * Server-side helpers for the /explorer/* routes.
 *
 * The skinny explorer (F.12.a) does not run an indexer. Every page computes
 * its data directly from the chain via an RPC client. That keeps infra cost
 * at zero — we already pay for Vercel, and the RPC endpoints are public —
 * but it means a few etherscan features are unavailable in v1:
 *
 *   - "txs sent/received by this address" across all of history requires a
 *     block-by-block scan, which is too slow for a request-time render. We
 *     show a bounded recent-blocks window instead.
 *   - "contract verification" requires a source-code submission pipeline,
 *     which is its own project. The explorer simply labels known deployed
 *     contracts by name (via `DEPLOYMENTS` + `EXTERNAL_ADDRESSES`).
 *
 * All functions here are intended for Server Components or Route Handlers
 * and must never be imported from a `'use client'` module.
 */

import {
  createPublicClient,
  http,
  getAddress,
  formatUnits,
  isAddress,
  isHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  DEPLOYMENTS,
  EXTERNAL_ADDRESSES,
  eticaMainnet,
} from '@etica-hub/shared';

const MAINNET_CHAIN_ID = 61803;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * RPC endpoints we try in order. The list mirrors `chains.ts` and prefers
 * Eticascan's endpoint first because it's run by the protocol itself and
 * has lenient rate limits for block-explorer-style load.
 *
 * Using `http()` with no URL falls back to viem's default which picks the
 * first entry from the chain's `rpcUrls`, giving us the same ordering
 * without hardcoding it twice.
 */
function getExplorerClient(): PublicClient {
  const override = process.env.ETICA_MAINNET_RPC_URL;
  return createPublicClient({
    chain: eticaMainnet,
    transport: override ? http(override) : http(),
  }) as PublicClient;
}

/** Singleton client — reused across requests within the same Node instance. */
let cachedClient: PublicClient | null = null;
export function explorerClient(): PublicClient {
  if (!cachedClient) cachedClient = getExplorerClient();
  return cachedClient;
}

/**
 * Human-readable labels for known deployed contracts on Etica mainnet.
 * Keyed by lowercased address so we don't have to checksum at lookup time.
 */
function buildAddressLabelMap(): Record<string, string> {
  const labels: Record<string, string> = {};
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];
  if (d) {
    const entries: Array<[Address | undefined, string]> = [
      [d.etx, 'ETX Token'],
      [d.wegaz, 'WEGAZ (Wrapped EGAZ)'],
      [d.swapFactory, 'EticaSwap Factory'],
      [d.swapRouter, 'EticaSwap Router'],
      [d.researchSubscription, 'Research Subscription'],
      [d.permit2, 'Permit2'],
      [d.dutchReactor, 'DutchOrderReactor'],
      [d.etxFeeController, 'ETX Fee Controller'],
      [d.orderRegistry, 'OrderRegistry'],
    ];
    for (const [addr, label] of entries) {
      if (addr && addr !== ZERO_ADDRESS) {
        labels[addr.toLowerCase()] = label;
      }
    }
  }
  if (ext) {
    const entries: Array<[Address | undefined, string]> = [
      [ext.eti, 'ETI Token'],
    ];
    for (const [addr, label] of entries) {
      if (addr && addr !== ZERO_ADDRESS) {
        labels[addr.toLowerCase()] = label;
      }
    }
  }
  return labels;
}

const ADDRESS_LABELS = buildAddressLabelMap();

/** Returns a human-friendly label for well-known contracts, or null. */
export function addressLabel(address: Address | string): string | null {
  return ADDRESS_LABELS[address.toLowerCase()] ?? null;
}

/** Shortens `0xabcdef…1234`; useful for narrow table cells. */
export function shortAddress(address: Address | string, size = 4): string {
  if (!address.startsWith('0x') || address.length < 2 + size * 2 + 2) {
    return address;
  }
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`;
}

/** Shortens a tx/block hash. */
export function shortHash(hash: string, size = 6): string {
  if (!hash.startsWith('0x') || hash.length <= 2 + size + 3) return hash;
  return `${hash.slice(0, 2 + size)}…${hash.slice(-size)}`;
}

/** Formats a bigint wei-value as EGAZ with up to 6 fractional digits. */
export function formatEgaz(wei: bigint): string {
  const full = formatUnits(wei, 18);
  const [int, frac = ''] = full.split('.');
  const shortFrac = frac.slice(0, 6).replace(/0+$/, '');
  return shortFrac ? `${int}.${shortFrac}` : int;
}

/** Unix seconds → "Jan 2 2025, 12:34:56 UTC". */
export function formatTimestamp(tsSec: bigint | number): string {
  const sec = typeof tsSec === 'bigint' ? Number(tsSec) : tsSec;
  const d = new Date(sec * 1000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Seconds elapsed between now and a past timestamp, rounded. */
export function secondsAgo(tsSec: bigint | number): number {
  const sec = typeof tsSec === 'bigint' ? Number(tsSec) : tsSec;
  return Math.max(0, Math.floor(Date.now() / 1000) - sec);
}

/** "12s ago", "4m ago", "1d ago". */
export function formatAgo(tsSec: bigint | number): string {
  const s = secondsAgo(tsSec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export type SearchKind = 'block' | 'tx' | 'address' | 'unknown';

export interface SearchResolution {
  kind: SearchKind;
  /** Canonical redirect target under /explorer, or null for 'unknown'. */
  path: string | null;
  /** Reason the query was rejected, if any (for UI messages). */
  reason?: string;
}

/**
 * Classifies a freeform query string from the search bar into a canonical
 * /explorer/* path. Pure string logic; no RPC calls — the block/tx/address
 * pages are the ones that actually verify existence.
 */
export function resolveSearchQuery(raw: string): SearchResolution {
  const q = raw.trim();
  if (!q) return { kind: 'unknown', path: null, reason: 'Empty query' };

  // Plain integer → block number.
  if (/^\d+$/.test(q)) {
    return { kind: 'block', path: `/explorer/block/${q}` };
  }

  // 0x-prefixed hex: 42 chars is address, 66 is block/tx hash.
  if (isAddress(q)) {
    return { kind: 'address', path: `/explorer/address/${getAddress(q)}` };
  }
  // Allow mixed-case addresses that fail strict EIP-55 — the explorer is a
  // read-only tool, so showing the right page on a paste from a random chat
  // matters more than enforcing checksums. We lowercase to sidestep viem's
  // isAddress strict check.
  if (/^0x[a-fA-F0-9]{40}$/.test(q)) {
    return {
      kind: 'address',
      path: `/explorer/address/${q.toLowerCase()}`,
    };
  }
  if (/^0x[a-fA-F0-9]{64}$/.test(q)) {
    // Could be tx hash OR block hash. We route to /tx/ first; the page is
    // expected to fall back to a block lookup if no tx matches.
    return { kind: 'tx', path: `/explorer/tx/${q}` };
  }

  return { kind: 'unknown', path: null, reason: 'Not a block number, tx hash, or address' };
}

/**
 * Re-exports viem guards for route handlers that want to validate route
 * params without importing viem directly.
 */
export const guards = { isAddress, isHex };

export type { Address, Hash, Hex, PublicClient };
