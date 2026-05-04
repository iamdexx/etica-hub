/**
 * GET /api/cron/buybot
 *
 * Scheduled Telegram buy bot. Runs on Vercel Cron (every minute) and:
 *   1. Reads `lastScannedBlock` from KV (Upstash / Vercel KV).
 *   2. Fetches `Swap` events across every EticaHub ETX-hub pair in the
 *      block range (lastScannedBlock, currentBlock].
 *   3. Formats each swap as a "{TOKEN} Buy" message and POSTs it to the
 *      configured Telegram channel.
 *   4. Writes the new cursor back to KV.
 *
 * Secured via Vercel's standard `CRON_SECRET` (bearer header) when set.
 * Returns enough debug info (`window`, `posts`, `skipped`) for ops to trace
 * a run without pulling logs.
 */

import { NextRequest } from 'next/server';
import { createPublicClient, getAddress, http, type Address, type PublicClient } from 'viem';
import { DEPLOYMENTS, TREASURY_ADDRESS, eticaMainnet } from '@etica-hub/shared';

import { loadBuyBotConfig, type BuyBotConfig } from '@/lib/buybot/config';
import {
  fetchCirculatingExcludes,
  fetchEgazNativeSupply,
  fetchUsdAnchors,
  type CirculatingExclusionEntry,
} from '@/lib/buybot/oracle';
import { computeBuyReport, decodeSwapAsBuy, type UsdPricing } from '@/lib/buybot/prices';
import { formatBuy } from '@/lib/buybot/format';
import { telegramClient } from '@/lib/buybot/telegram';
import {
  fetchAnchorEtxUsd,
  fetchSwapsInRange,
  loadAllPairs,
  planScanWindow,
  snapshotPool,
} from '@/lib/buybot/scan';
import {
  claimBuyPost,
  kvFor,
  memoryKv,
  postedKey,
  readLastScannedBlock,
  writeLastScannedBlock,
} from '@/lib/buybot/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Give viem enough budget to batch the per-pair reserve reads on a cold run.
export const maxDuration = 60;

interface CronResult {
  ok: boolean;
  enabled: boolean;
  window?: { fromBlock: string; toBlock: string };
  scanned?: number;
  posted?: number;
  skipped?: { reason: string; count: number }[];
  error?: string;
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: 'unauthorized' } as CronResult, {
    status: 401,
  });
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured → allow (dev / preview)
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

function makeClient(config: BuyBotConfig): PublicClient {
  return createPublicClient({
    chain: eticaMainnet,
    transport: http(config.rpcUrl),
  }) as PublicClient;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!authorized(req)) return unauthorized();

  const config = loadBuyBotConfig();
  if (!config.enabled) {
    return Response.json({
      ok: true,
      enabled: false,
      error: 'BUYBOT_TELEGRAM_BOT_TOKEN / BUYBOT_TELEGRAM_CHAT_ID / BUYBOT_RPC_URL not set',
    } satisfies CronResult);
  }

  // In production we refuse to run without persistent KV: without it the cron
  // would rescan the same lookback window every minute and spam duplicates.
  const usingProd = process.env.VERCEL_ENV === 'production';
  const kv = kvFor(config) ?? (usingProd ? null : memoryKv());
  if (!kv) {
    return Response.json(
      {
        ok: false,
        enabled: true,
        error:
          'KV credentials missing in production — set either KV_REST_API_URL + KV_REST_API_TOKEN (Upstash/Vercel KV REST) or REDIS_URL (TCP)',
      } satisfies CronResult,
      { status: 500 },
    );
  }

  try {
    const client = makeClient(config);

    // Sourced from `DEPLOYMENTS[chainId]` so MC math always reflects the
    // currently-wired protocol contracts; missing deployments (zero
    // addresses on testnet / fresh chain) drop out of the registry
    // automatically without changing the call shape.
    const exclusionRegistry = buildExclusionRegistry(config);

    const [latestBlock, lastScanned, anchors, wegazNativeSupply, excludedSupplyByToken] =
      await Promise.all([
        client.getBlockNumber(),
        readLastScannedBlock(kv, config),
        fetchUsdAnchors(config),
        // Pulled once per run from BlockScout's `coinsupply` endpoint so MC
        // reflects the chain's full native EGAZ supply, not just the wrapped
        // ERC-20 slice. A null result falls back to `WEGAZ.totalSupply()`.
        fetchEgazNativeSupply(config),
        // One `balanceOf` per (token, holder) pair, summed per token. Used
        // by `computeBuyReport` to quote circulating-supply MC instead of
        // fully-diluted MC; aligns the buybot with CoinGecko/CMC/DEX
        // Screener convention.
        fetchCirculatingExcludes(client, exclusionRegistry),
      ]);

    const hideMcForTokens = buildHideMcSet(config);

    // Resolve ETX/USD independently of which swaps happen this cycle by
    // reading reserves on the ETX/EGAZ (preferred) or ETX/ETI anchor pool
    // directly. Without this, a run that only sees stETX/ETX or launchpad
    // swaps would have etxUsd=null and render MC as "—".
    const anchorEtxUsd = await fetchAnchorEtxUsd(client, {
      factory: config.factory,
      etx: config.etx,
      eti: config.eti,
      wegaz: config.wegaz,
      anchors,
    });

    const window = planScanWindow(latestBlock, lastScanned, config);
    const pairs = await loadAllPairs(client, config.factory);

    if (pairs.length === 0 || window.toBlock < window.fromBlock) {
      await writeLastScannedBlock(kv, config, window.toBlock);
      return Response.json({
        ok: true,
        enabled: true,
        window: {
          fromBlock: window.fromBlock.toString(),
          toBlock: window.toBlock.toString(),
        },
        scanned: 0,
        posted: 0,
      } satisfies CronResult);
    }

    const swaps = await fetchSwapsInRange(client, pairs, window);

    // Snapshot each unique pair once per run rather than per swap.
    const poolsByPair = new Map<string, Awaited<ReturnType<typeof snapshotPool>>>();
    for (const s of swaps) {
      const key = `${s.pair}@${s.blockNumber.toString()}`;
      if (!poolsByPair.has(key)) {
        poolsByPair.set(key, await snapshotPool(client, s.pair, s.blockNumber));
      }
    }

    // Prefer the anchor-pool read (always available); fall back to deriving
    // from a swap snapshot if the anchor call errored (e.g. no ETX/EGAZ pool
    // exists yet on this chain).
    const derived: UsdPricing =
      anchorEtxUsd !== null
        ? { etxUsd: anchorEtxUsd, etiUsd: anchors.etiUsd, egazUsd: anchors.egazUsd }
        : deriveEtxUsd({
            swaps,
            poolsByPair,
            anchors,
            etx: config.etx,
            eti: config.eti,
            wegaz: config.wegaz,
          });
    const pricing: UsdPricing = derived;

    const telegram = telegramClient(config.telegramBotToken, config.telegramChatId);

    let posted = 0;
    const skipped = new Map<string, number>();
    const bump = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

    for (const swap of swaps) {
      const pool = poolsByPair.get(`${swap.pair}@${swap.blockNumber.toString()}`);
      if (!pool) {
        bump('pool-snapshot-failed');
        continue;
      }
      const decoded = decodeSwapAsBuy(pool, swap.args);
      if (!decoded) {
        bump('undecodable-swap');
        continue;
      }
      const report = computeBuyReport(decoded, config.etx, config.eti, config.wegaz, pricing, {
        wegazNativeSupply,
        excludedSupplyByToken,
        hideMcForTokens,
      });
      if (report.notionalUsd !== null && report.notionalUsd < config.minUsdToPost) {
        bump('below-min-usd');
        continue;
      }

      // Cheap pre-check: if a prior successful run already claimed this
      // swap, skip it outright. Does NOT claim — we only write the claim
      // after the telegram send succeeds, so a failed send never locks a
      // swap out of retries. A transient KV read error is treated as
      // "not seen" so a flaky KV can't stall the loop indefinitely on
      // the same swap (worst case: one duplicate post once KV recovers,
      // which is the same tradeoff as the post-send claim write below).
      let seen: string | null = null;
      try {
        seen = await kv.get(postedKey(config, swap.txHash, swap.logIndex));
      } catch {
        bump('dedup-read-failed');
      }
      if (seen) {
        bump('already-posted');
        continue;
      }

      const msg = formatBuy({
        decoded,
        report,
        txHash: swap.txHash,
        blockNumber: swap.blockNumber,
        explorerBaseUrl: config.explorerBaseUrl,
      });
      const send = await telegram.sendMessage(msg);
      if (send.ok) {
        posted += 1;
        // Record the claim only after a successful send. If this throws
        // (transient KV outage), we swallow it: the message is already
        // delivered; a duplicate on the next rescan is strictly less bad
        // than crashing the loop mid-batch.
        try {
          await claimBuyPost(kv, config, swap.txHash, swap.logIndex);
        } catch {
          bump('claim-write-failed');
        }
      } else {
        bump(`telegram-${send.status}`);
      }
    }

    await writeLastScannedBlock(kv, config, window.toBlock);

    return Response.json({
      ok: true,
      enabled: true,
      window: {
        fromBlock: window.fromBlock.toString(),
        toBlock: window.toBlock.toString(),
      },
      scanned: swaps.length,
      posted,
      skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    } satisfies CronResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, enabled: true, error: msg } satisfies CronResult, {
      status: 500,
    });
  }
}

/**
 * Resolve ETX/USD from the first pool snapshot that pairs ETX with ETI or
 * WEGAZ. We only anchor USD via pools we *actually saw a swap on* this run
 * because those are the snapshots we already paid for; if none exist, ETX
 * USD stays `null` and downstream messages fall back to showing "—".
 */
function deriveEtxUsd(args: {
  swaps: { pair: `0x${string}`; blockNumber: bigint }[];
  poolsByPair: Map<string, Awaited<ReturnType<typeof snapshotPool>>>;
  anchors: { etiUsd: number | null; egazUsd: number | null };
  etx: `0x${string}`;
  eti: `0x${string}`;
  wegaz: `0x${string}`;
}): UsdPricing {
  const { swaps, poolsByPair, anchors, etx, eti, wegaz } = args;
  for (const swap of swaps) {
    const pool = poolsByPair.get(`${swap.pair}@${swap.blockNumber.toString()}`);
    if (!pool) continue;
    const t0 = pool.token0.address.toLowerCase();
    const t1 = pool.token1.address.toLowerCase();
    const etxLc = etx.toLowerCase();
    const etiLc = eti.toLowerCase();
    const wegazLc = wegaz.toLowerCase();

    // Figure out which side is ETX and which is the anchor asset.
    const r0 = Number(pool.reserve0After) / 10 ** pool.token0.decimals;
    const r1 = Number(pool.reserve1After) / 10 ** pool.token1.decimals;
    if (r0 === 0 || r1 === 0) continue;

    let etxInOther: number | null = null;
    let anchorUsd: number | null = null;
    if (t0 === etxLc && (t1 === etiLc || t1 === wegazLc)) {
      etxInOther = r1 / r0; // "other" per ETX
      anchorUsd = t1 === etiLc ? anchors.etiUsd : anchors.egazUsd;
    } else if (t1 === etxLc && (t0 === etiLc || t0 === wegazLc)) {
      etxInOther = r0 / r1;
      anchorUsd = t0 === etiLc ? anchors.etiUsd : anchors.egazUsd;
    }

    if (etxInOther !== null && anchorUsd !== null) {
      return {
        etxUsd: etxInOther * anchorUsd,
        etiUsd: anchors.etiUsd,
        egazUsd: anchors.egazUsd,
      };
    }
  }
  return { etxUsd: null, etiUsd: anchors.etiUsd, egazUsd: anchors.egazUsd };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/**
 * Resolve which DEPLOYMENTS entry (and thus which set of treasury / fee
 * splitter / timelock addresses) to use for circulating-supply math on
 * the chain the bot is currently scanning.
 */
function deploymentsFor(config: BuyBotConfig): (typeof DEPLOYMENTS)[keyof typeof DEPLOYMENTS] {
  return DEPLOYMENTS[config.chainId as keyof typeof DEPLOYMENTS] ?? DEPLOYMENTS[61803];
}

/**
 * Build the per-token list of non-circulating holders to subtract from
 * `totalSupply()` before MC math. Pool reserves are intentionally NOT
 * included — they're swappable by anyone, which the standard
 * "circulating supply" convention treats as in-circulation.
 *
 * For ETX, that means: treasury wallet (where harvest proceeds and any
 * future LP unlock would land), TreasuryHarvester (transient harvest
 * balance), the stableswap fee-splitter adapter (also transient), and
 * the LiquidityTimelock10y. The timelock holds LP shares not ETX
 * directly today, but listing it here is forward-safe: if any future
 * mechanism routes ETX through it, the registry already accounts for it.
 *
 * Zero-address entries (testnet / undeployed) are filtered out.
 */
function buildExclusionRegistry(config: BuyBotConfig): CirculatingExclusionEntry[] {
  const d = deploymentsFor(config);
  const dedupe = (addrs: Address[]): Address[] => {
    const seen = new Set<string>();
    const out: Address[] = [];
    for (const a of addrs) {
      if (a === ZERO_ADDRESS) continue;
      const k = getAddress(a);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  };

  const etxHolders = dedupe([
    TREASURY_ADDRESS,
    d.treasuryHarvester,
    d.stableSwapHarvesterAdapter,
    d.liquidityTimelock10y,
  ]);

  const entries: CirculatingExclusionEntry[] = [];
  if (config.etx !== ZERO_ADDRESS && etxHolders.length > 0) {
    entries.push({ token: getAddress(config.etx), holders: etxHolders });
  }
  return entries;
}

/**
 * Tokens whose MC line should be hidden in buy-bot posts because their
 * `price × totalSupply` simply reproduces the underlying asset's MC.
 *
 * Today only stETX qualifies: every stETX share is 1 ETX-at-NAV that
 * `ETX.totalSupply()` already accounts for. Showing it would
 * double-count on cross-token totals and confuse readers tallying
 * protocol-wide MC.
 */
function buildHideMcSet(config: BuyBotConfig): Set<Address> {
  const d = deploymentsFor(config);
  const out = new Set<Address>();
  if (d.stakedETX !== ZERO_ADDRESS) out.add(getAddress(d.stakedETX));
  return out;
}
