import { createPublicClient, getAddress, http } from 'viem';
import { fetchAllPairs, headBlockAgeSeconds, priceClient } from '@/lib/priceApi';
import { rpcEndpoints } from '@/lib/rpc';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';

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
 * Reads the chain head + factory pair count. `ok` is true iff an RPC is
 * reachable, the factory decoded, and the head block is within budget.
 * The head is taken from whichever public endpoint answers with the newest
 * block, so one lagging node can't flag the chain as stale, and the factory
 * is read through that same endpoint so the pair data is as fresh as the head.
 */
export async function computeHealth(): Promise<HealthReport> {
  const startedAt = Date.now();
  let head: { number: bigint; timestamp: bigint; url: string } | null = null;
  let pairs: Awaited<ReturnType<typeof fetchAllPairs>> | null = null;
  const errors: string[] = [];

  const heads = await Promise.allSettled(
    rpcEndpoints(eticaMainnet, process.env.ETICA_MAINNET_RPC_URL).map(async (url) => {
      const block = await createPublicClient({
        chain: eticaMainnet,
        transport: http(url, { timeout: 5_000, retryCount: 0 }),
      }).getBlock({ blockTag: 'latest' });
      return { number: block.number, timestamp: block.timestamp, url };
    }),
  );
  for (const h of heads) {
    if (h.status !== 'fulfilled') continue;
    if (!head || h.value.timestamp > head.timestamp) head = h.value;
  }
  if (!head) {
    const reasons = heads.map((h) =>
      h.status === 'rejected'
        ? String(h.reason instanceof Error ? h.reason.message : h.reason)
        : '',
    );
    errors.push(`rpc: ${reasons.filter(Boolean).join(' | ') || 'no endpoint answered'}`);
  }

  const client = head
    ? createPublicClient({
        chain: eticaMainnet,
        transport: http(head.url, { timeout: 5_000, retryCount: 1 }),
      })
    : priceClient();
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
