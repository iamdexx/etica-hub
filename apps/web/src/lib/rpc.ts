import { fallback, http, type Chain, type Transport } from 'viem';

/**
 * Ordered, de-duplicated RPC endpoint list: the explicitly configured URL
 * first (if any), then the chain's public RPCs as automatic failovers.
 */
export function rpcEndpoints(chain: Chain, preferred?: string | null): string[] {
  return Array.from(
    new Set([preferred, ...chain.rpcUrls.default.http].filter((u): u is string => !!u)),
  );
}

/**
 * Failover transport: tries each endpoint in order with a bounded timeout so
 * one dead or rate-limited node can't 500 the request.
 */
export function failoverTransport(chain: Chain, preferred?: string | null): Transport {
  const endpoints = rpcEndpoints(chain, preferred);
  if (endpoints.length === 0) return http();
  return fallback(
    endpoints.map((url) => http(url, { timeout: 5_000, retryCount: 1 })),
    { rank: false },
  );
}
