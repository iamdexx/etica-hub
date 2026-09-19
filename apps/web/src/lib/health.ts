import { getAddress } from 'viem';
import { fetchAllPairs, headBlockAgeSeconds, priceClient } from '@/lib/priceApi';
import { DEPLOYMENTS } from '@etica-hub/shared';

const MAINNET_CHAIN_ID = 61803;
/** Acceptable upper bound on head-block age before we flip `ok` to false. */
export const STALE_HEAD_SECONDS = 120;

export interface HealthReport {
  ok: boolean;
  chainId: number;
  chain: 'etica-mainnet';
  headBlockNumber: string | null;
  headBlockTimestamp: number | null;
  headAgeSeconds: number | null;
  stale: boolean;
  staleThresholdSeconds: number;
  pairCount: number | null;
  factoryAddress: string | null;
  responseTimeMs: number;
  errors: string[];
}

/**
 * Reads the chain head + factory pair count. `ok` is true iff the RPC is
 * reachable, the factory decoded, and the head block is within budget.
 */
export async function computeHealth(): Promise<HealthReport> {
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

  return {
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
}
