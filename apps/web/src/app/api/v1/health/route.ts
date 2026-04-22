/**
 * GET /api/v1/health
 *
 * Cheap liveness check for aggregator bots and status pages. Reads the
 * chain head + factory pair count and returns an `ok` flag that's true
 * iff:
 *   - RPC is reachable,
 *   - we could decode a pair count from the factory, and
 *   - head-block age is within the configured staleness budget.
 *
 * The endpoint itself is intentionally boring and has no side effects.
 * Keep the cache window short (5s) so monitoring systems see near-real-
 * time state without hammering RPC.
 */

import { getAddress } from 'viem';
import {
  fetchAllPairs,
  headBlockAgeSeconds,
  jsonResponse,
  priceClient,
} from '@/lib/priceApi';
import { DEPLOYMENTS } from '@etica-hub/shared';

export const runtime = 'nodejs';
export const revalidate = 5;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
/** Acceptable upper bound on head-block age before we flip `ok` to false. */
const STALE_HEAD_SECONDS = 120;

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  const client = priceClient();

  let head: { number: bigint; timestamp: bigint } | null = null;
  let pairs: Awaited<ReturnType<typeof fetchAllPairs>> | null = null;
  const errors: string[] = [];

  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    head = { number: block.number, timestamp: block.timestamp };
  } catch (err) {
    errors.push(`rpc: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    pairs = await fetchAllPairs(client);
  } catch (err) {
    errors.push(`factory: ${err instanceof Error ? err.message : String(err)}`);
  }

  const headAge = head ? headBlockAgeSeconds(Number(head.timestamp)) : null;
  const stale = headAge == null ? true : headAge > STALE_HEAD_SECONDS;
  const ok = errors.length === 0 && !stale;

  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];

  const body = {
    ok,
    chainId: MAINNET_CHAIN_ID,
    chain: 'etica-mainnet',
    headBlockNumber: head ? head.number.toString() : null,
    headBlockTimestamp: head ? Number(head.timestamp) : null,
    headAgeSeconds: headAge,
    stale,
    staleThresholdSeconds: STALE_HEAD_SECONDS,
    pairCount: pairs?.length ?? null,
    factoryAddress: d ? getAddress(d.swapFactory) : null,
    responseTimeMs: Date.now() - startedAt,
    errors,
  };

  return jsonResponse(body, { status: ok ? 200 : 503 });
}
