/**
 * Widget referral ledger.
 *
 * Third-party sites embed `/embed/v2-pool?ref=0xTheirWallet`. The widget
 * appends the host wallet as a 20-byte calldata suffix to every swap it sends
 * to the standalone router (Solidity ignores trailing calldata), then posts the
 * tx hash here. We re-read the transaction and receipt on-chain and credit the
 * host only when: the tx went to `v2Router`, its calldata ends with that host's
 * address, it succeeded, and it emitted `Swap` from a pair the standalone
 * factory registered (`getPair(token0, token1) == emitter`). Nothing posted by
 * the client is trusted beyond the hash and the ref address.
 *
 * Economics (same pair contract as the hub): 0.30% swap fee, 0.25% to LPs,
 * 0.05% to the protocol (`feeTo`). The host's commission is a share of the
 * protocol's 0.05%, paid off-chain from treasury fee income.
 */

import { getAddress, isAddress, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { DEPLOYMENTS, USDC_WARP_ROUTE, abis, eticaMainnet } from '@etica-hub/shared';
import { aiBotKvFor, memoryAiBotKv, type AiBotKv } from '@/lib/aibot/kv';
import { memoryKv, restKv, tcpKv, type KvStore } from '@/lib/buybot/state';
import { priceClient } from '@/lib/priceApi';

export const SWAP_FEE_BPS = 30;
/** Protocol share of the swap fee (1/6, as minted to `feeTo` by the pair). */
export const PROTOCOL_FEE_SHARE = 1 / 6;
/** Host's share of the protocol fee on swaps sent through their widget. */
export const REFERRAL_SHARE_OF_PROTOCOL_FEE = 0.5;

const ZERO: Address = '0x0000000000000000000000000000000000000000';
/**
 * Claim window while the volume counter is written; made permanent afterwards.
 * Long on purpose: the only retry we expect is the widget's own single post,
 * and a lapsed claim after a successful increment would double-count.
 */
const CLAIM_TTL_SECONDS = 24 * 60 * 60;
const COUNTER_TTL_SECONDS = 20 * 365 * 24 * 60 * 60;

export interface ReferralTotals {
  ref: Address;
  swaps: number;
  /** Gross traded volume in USDC.e terms (the USDC.e leg of each swap). */
  volumeUsd: number;
  /** Total swap fees (0.30%) those swaps generated, in USDC.e terms. */
  feesUsd: number;
  /** Commission owed to the host, in USDC.e terms. */
  commissionUsd: number;
  firstTxAt: string | null;
  lastTxAt: string | null;
  lastTx: Hex | null;
}

export type CreditStatus = 'credited' | 'duplicate' | 'no-swap' | 'not-found' | 'failed-tx' | 'not-widget-tx' | 'price-unavailable';

export interface CreditResult {
  status: CreditStatus;
  swaps: number;
  volumeUsd: number;
  totals: ReferralTotals | null;
}

export interface ReferralStore {
  kv: KvStore;
  counters: AiBotKv;
}

let memory: ReferralStore | null = null;

export function referralStore(): ReferralStore | null {
  const redisUrl = process.env.REDIS_URL ?? null;
  const kvRestUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? null;
  const kvRestToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? null;
  const counters = aiBotKvFor({ kvRestUrl, kvRestToken, redisUrl });
  if (counters) {
    const kv = kvRestUrl && kvRestToken ? restKv(kvRestUrl, kvRestToken) : tcpKv(redisUrl!);
    return { kv, counters };
  }
  if (process.env.VERCEL_ENV === 'production') return null;
  memory ??= memoryReferralStore();
  return memory;
}

export function memoryReferralStore(): ReferralStore {
  return { kv: memoryKv(), counters: memoryAiBotKv() };
}

const key = (ref: Address, field: string) => `widget:ref:${ref.toLowerCase()}:${field}`;
const txKey = (tx: Hex) => `widget:ref:tx:${tx.toLowerCase()}`;

export function emptyTotals(ref: Address): ReferralTotals {
  return { ref, swaps: 0, volumeUsd: 0, feesUsd: 0, commissionUsd: 0, firstTxAt: null, lastTxAt: null, lastTx: null };
}

export async function getReferralTotals(store: ReferralStore, refRaw: string): Promise<ReferralTotals | null> {
  if (!isAddress(refRaw, { strict: false })) return null;
  const ref = getAddress(refRaw);
  // Volume is the single source of truth; fees and commission are derived from it.
  const [swaps, volumeUsd, metaRaw] = await Promise.all([
    store.counters.getNumber(key(ref, 'swaps')),
    store.counters.getNumber(key(ref, 'volume')),
    store.kv.get(key(ref, 'meta')),
  ]);
  const feesUsd = volumeUsd * (SWAP_FEE_BPS / 10_000);
  let meta: Partial<Pick<ReferralTotals, 'firstTxAt' | 'lastTxAt' | 'lastTx'>> = {};
  if (metaRaw) {
    try {
      meta = JSON.parse(metaRaw) as typeof meta;
    } catch {
      meta = {};
    }
  }
  return {
    ...emptyTotals(ref),
    ...meta,
    ref,
    swaps,
    volumeUsd,
    feesUsd,
    commissionUsd: feesUsd * PROTOCOL_FEE_SHARE * REFERRAL_SHARE_OF_PROTOCOL_FEE,
  };
}

/** Calldata suffix the widget appends to router swaps so the host is provable on-chain. */
export function referralSuffix(ref: Address): Hex {
  return `0x${getAddress(ref).slice(2).toLowerCase()}`;
}

/**
 * USDC.e volume of the swaps in `tx` that hit a standalone-V2 pair, provided
 * the tx is a widget swap tagged with `ref`.
 */
export async function widgetSwapVolumeUsd(
  tx: Hex,
  ref: Address,
  client: PublicClient = priceClient(),
): Promise<{ status: 'ok' | 'not-found' | 'failed-tx' | 'not-widget-tx' | 'price-unavailable'; swaps: number; volumeUsd: number }> {
  const d = DEPLOYMENTS[eticaMainnet.id];
  if (d.v2Factory === ZERO || d.v2Router === ZERO) return { status: 'ok', swaps: 0, volumeUsd: 0 };
  let receipt;
  let txn;
  try {
    [receipt, txn] = await Promise.all([client.getTransactionReceipt({ hash: tx }), client.getTransaction({ hash: tx })]);
  } catch {
    return { status: 'not-found', swaps: 0, volumeUsd: 0 };
  }
  const suffix = referralSuffix(ref).slice(2);
  if (
    !txn.to ||
    txn.to.toLowerCase() !== d.v2Router.toLowerCase() ||
    txn.input.length <= 10 + suffix.length ||
    !txn.input.toLowerCase().endsWith(suffix)
  ) {
    return { status: 'not-widget-tx', swaps: 0, volumeUsd: 0 };
  }
  if (receipt.status !== 'success') return { status: 'failed-tx', swaps: 0, volumeUsd: 0 };

  const swaps = parseEventLogs({ abi: abis.pairAbi, logs: receipt.logs, eventName: 'Swap' });
  const usdc = USDC_WARP_ROUTE.syntheticToken.toLowerCase();
  const etx = d.etx.toLowerCase();
  let count = 0;
  // USDC.e legs count at face value; ETX legs (pools without USDC.e) at the USDC.e/ETX spot
  let volumeUsdc = 0n;
  let volumeEtx = 0n;
  const verified = new Map<string, { isOurs: boolean; side: 'usdc' | 'etx' | null; is0: boolean }>();
  for (const log of swaps) {
    const pair = getAddress(log.address);
    let meta = verified.get(pair);
    if (!meta) {
      const [token0, token1] = await Promise.all([
        client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'token0' }) as Promise<Address>,
        client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'token1' }) as Promise<Address>,
      ]);
      const registered = (await client.readContract({
        abi: abis.factoryAbi,
        address: d.v2Factory,
        functionName: 'getPair',
        args: [token0, token1],
      })) as Address;
      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      const side = t0 === usdc || t1 === usdc ? 'usdc' : t0 === etx || t1 === etx ? 'etx' : null;
      const is0 = side === 'usdc' ? t0 === usdc : t0 === etx;
      meta = { isOurs: registered.toLowerCase() === pair.toLowerCase() && side !== null, side, is0 };
      verified.set(pair, meta);
    }
    if (!meta.isOurs) continue;
    const { amount0In, amount1In, amount0Out, amount1Out } = log.args;
    const legIn = meta.is0 ? amount0In : amount1In;
    const legOut = meta.is0 ? amount0Out : amount1Out;
    const leg = legIn > legOut ? legIn : legOut;
    if (meta.side === 'usdc') volumeUsdc += leg;
    else volumeEtx += leg;
    count += 1;
  }
  let volumeUsd = Number(volumeUsdc) / 10 ** USDC_WARP_ROUTE.decimals;
  if (volumeEtx > 0n) {
    const px = await etxPriceUsdc(client);
    // no price this moment (RPC hiccup, pools unseeded): leave the tx unclaimed so it can be re-posted
    if (px === null) return { status: 'price-unavailable', swaps: 0, volumeUsd: 0 };
    volumeUsd += (Number(volumeEtx) / 1e18) * px;
  }
  return { status: 'ok', swaps: count, volumeUsd };
}

/**
 * USDC.e per ETX: the lower of the standalone and hub USDC.e/ETX spots, so a
 * host cannot inflate an ETX-pool commission by pumping one pool just before
 * posting the swap (they would have to move both, and the commission is a
 * fraction of 0.05 % of volume, far below the slippage that costs). Null when
 * neither pool is seeded or readable.
 */
async function etxPriceUsdc(client: PublicClient): Promise<number | null> {
  const d = DEPLOYMENTS[eticaMainnet.id];
  const usdc = USDC_WARP_ROUTE.syntheticToken;
  const prices: number[] = [];
  for (const factory of [d.v2Factory, d.swapFactory]) {
    if (factory === ZERO) continue;
    try {
      const pair = (await client.readContract({ abi: abis.factoryAbi, address: factory, functionName: 'getPair', args: [usdc, d.etx] })) as Address;
      if (pair === ZERO) continue;
      const [[r0, r1], token0] = await Promise.all([
        client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'getReserves' }) as Promise<readonly [bigint, bigint, number]>,
        client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'token0' }) as Promise<Address>,
      ]);
      const [rU, rE] = token0.toLowerCase() === usdc.toLowerCase() ? [r0, r1] : [r1, r0];
      if (rU === 0n || rE === 0n) continue;
      prices.push(Number(rU) / 10 ** USDC_WARP_ROUTE.decimals / (Number(rE) / 1e18));
    } catch {
      /* unreadable this moment: the other pool may still price it */
    }
  }
  return prices.length ? Math.min(...prices) : null;
}

export async function creditWidgetSwap(
  store: ReferralStore,
  txRaw: string,
  refRaw: string,
  client: PublicClient = priceClient(),
): Promise<CreditResult | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txRaw) || !isAddress(refRaw, { strict: false })) return null;
  const tx = txRaw.toLowerCase() as Hex;
  const ref = getAddress(refRaw);

  const vol = await widgetSwapVolumeUsd(tx, ref, client);
  if (vol.status !== 'ok') return { status: vol.status, swaps: 0, volumeUsd: 0, totals: null };
  if (vol.swaps === 0) return { status: 'no-swap', swaps: 0, volumeUsd: 0, totals: null };

  // Claim first (lapses if the single money write below fails, so the swap can
  // be re-posted), then exactly one atomic increment of the volume counter,
  // then the claim is made permanent. The swap count is informational only.
  const fresh = await store.kv.setIfAbsent(txKey(tx), ref, CLAIM_TTL_SECONDS);
  if (!fresh) {
    return { status: 'duplicate', swaps: vol.swaps, volumeUsd: vol.volumeUsd, totals: await getReferralTotals(store, ref) };
  }
  await store.counters.incrFloat(key(ref, 'volume'), vol.volumeUsd, COUNTER_TTL_SECONDS);
  await store.kv.set(txKey(tx), ref);
  await store.counters.incrCounter(key(ref, 'swaps'), COUNTER_TTL_SECONDS).catch(() => 0);
  const now = new Date().toISOString();
  const prevMeta = await store.kv.get(key(ref, 'meta')).catch(() => null);
  let firstTxAt: string | null = null;
  if (prevMeta) {
    try {
      firstTxAt = (JSON.parse(prevMeta) as { firstTxAt?: string | null }).firstTxAt ?? null;
    } catch {
      firstTxAt = null;
    }
  }
  await store.kv.set(key(ref, 'meta'), JSON.stringify({ firstTxAt: firstTxAt ?? now, lastTxAt: now, lastTx: tx })).catch(() => {});
  return { status: 'credited', swaps: vol.swaps, volumeUsd: vol.volumeUsd, totals: await getReferralTotals(store, ref) };
}
