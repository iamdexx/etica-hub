/**
 * Widget referral ledger.
 *
 * Third-party sites embed `/embed/v2-pool?ref=0xTheirWallet`. After a swap
 * confirms, the widget posts the tx hash; we re-read the receipt on-chain,
 * keep only `Swap` events emitted by pairs of the standalone V2 factory, and
 * credit the host with the fee that trade generated. Nothing is trusted from
 * the client beyond the hash and the ref address.
 *
 * Economics (same pair contract as the hub): 0.30% swap fee, 0.25% to LPs,
 * 0.05% to the protocol (`feeTo`). The host's commission is a share of the
 * protocol's 0.05%, paid off-chain from treasury fee income.
 */

import { getAddress, isAddress, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { DEPLOYMENTS, USDC_WARP_ROUTE, abis, eticaMainnet } from '@etica-hub/shared';
import { memoryKv, restKv, tcpKv, type KvStore } from '@/lib/buybot/state';
import { priceClient } from '@/lib/priceApi';

export const SWAP_FEE_BPS = 30;
/** Protocol share of the swap fee (1/6, as minted to `feeTo` by the pair). */
export const PROTOCOL_FEE_SHARE = 1 / 6;
/** Host's share of the protocol fee on swaps sent through their widget. */
export const REFERRAL_SHARE_OF_PROTOCOL_FEE = 0.5;

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const pairFactoryAbi = [
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const TX_DEDUPE_TTL_SECONDS = 400 * 24 * 60 * 60;

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

export interface CreditResult {
  status: 'credited' | 'duplicate' | 'no-swap' | 'not-found' | 'failed-tx';
  swaps: number;
  volumeUsd: number;
  totals: ReferralTotals | null;
}

let memory: KvStore | null = null;

export function referralStore(): KvStore | null {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) return tcpKv(redisUrl);
  const restUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) return restKv(restUrl, restToken);
  if (process.env.VERCEL_ENV === 'production') return null;
  memory ??= memoryKv();
  return memory;
}

const totalsKey = (ref: Address) => `widget:ref:${ref.toLowerCase()}`;
const txKey = (tx: Hex) => `widget:ref:tx:${tx.toLowerCase()}`;

export function emptyTotals(ref: Address): ReferralTotals {
  return { ref, swaps: 0, volumeUsd: 0, feesUsd: 0, commissionUsd: 0, firstTxAt: null, lastTxAt: null, lastTx: null };
}

export async function getReferralTotals(kv: KvStore, refRaw: string): Promise<ReferralTotals | null> {
  if (!isAddress(refRaw, { strict: false })) return null;
  const ref = getAddress(refRaw);
  const raw = await kv.get(totalsKey(ref));
  if (!raw) return emptyTotals(ref);
  try {
    return { ...emptyTotals(ref), ...(JSON.parse(raw) as Partial<ReferralTotals>), ref };
  } catch {
    return emptyTotals(ref);
  }
}

/** USDC.e volume of the swaps in `tx` that hit a standalone-V2 pair. */
export async function widgetSwapVolumeUsd(
  tx: Hex,
  client: PublicClient = priceClient(),
): Promise<{ status: 'ok' | 'not-found' | 'failed-tx'; swaps: number; volumeUsd: number }> {
  const d = DEPLOYMENTS[eticaMainnet.id];
  if (d.v2Factory === ZERO) return { status: 'ok', swaps: 0, volumeUsd: 0 };
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: tx });
  } catch {
    return { status: 'not-found', swaps: 0, volumeUsd: 0 };
  }
  if (receipt.status !== 'success') return { status: 'failed-tx', swaps: 0, volumeUsd: 0 };

  const swaps = parseEventLogs({ abi: abis.pairAbi, logs: receipt.logs, eventName: 'Swap' });
  const usdc = USDC_WARP_ROUTE.syntheticToken.toLowerCase();
  let count = 0;
  let volume = 0n;
  const verified = new Map<string, { isOurs: boolean; usdcIs0: boolean }>();
  for (const log of swaps) {
    const pair = getAddress(log.address);
    let meta = verified.get(pair);
    if (!meta) {
      const [factory, token0, token1] = await Promise.all([
        client.readContract({ abi: pairFactoryAbi, address: pair, functionName: 'factory' }) as Promise<Address>,
        client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'token0' }) as Promise<Address>,
        client.readContract({ abi: abis.pairAbi, address: pair, functionName: 'token1' }) as Promise<Address>,
      ]);
      const usdcIs0 = token0.toLowerCase() === usdc;
      const usdcIs1 = token1.toLowerCase() === usdc;
      meta = { isOurs: factory.toLowerCase() === d.v2Factory.toLowerCase() && (usdcIs0 || usdcIs1), usdcIs0 };
      verified.set(pair, meta);
    }
    if (!meta.isOurs) continue;
    const { amount0In, amount1In, amount0Out, amount1Out } = log.args;
    const usdIn = meta.usdcIs0 ? amount0In : amount1In;
    const usdOut = meta.usdcIs0 ? amount0Out : amount1Out;
    volume += usdIn > usdOut ? usdIn : usdOut;
    count += 1;
  }
  return { status: 'ok', swaps: count, volumeUsd: Number(volume) / 10 ** USDC_WARP_ROUTE.decimals };
}

export async function creditWidgetSwap(
  kv: KvStore,
  txRaw: string,
  refRaw: string,
  client: PublicClient = priceClient(),
): Promise<CreditResult | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txRaw) || !isAddress(refRaw, { strict: false })) return null;
  const tx = txRaw.toLowerCase() as Hex;
  const ref = getAddress(refRaw);

  const vol = await widgetSwapVolumeUsd(tx, client);
  if (vol.status !== 'ok') return { status: vol.status, swaps: 0, volumeUsd: 0, totals: null };
  if (vol.swaps === 0) return { status: 'no-swap', swaps: 0, volumeUsd: 0, totals: null };

  const fresh = await kv.setIfAbsent(txKey(tx), ref, TX_DEDUPE_TTL_SECONDS);
  const totals = (await getReferralTotals(kv, ref)) ?? emptyTotals(ref);
  if (!fresh) return { status: 'duplicate', swaps: vol.swaps, volumeUsd: vol.volumeUsd, totals };

  const feesUsd = vol.volumeUsd * (SWAP_FEE_BPS / 10_000);
  const now = new Date().toISOString();
  const next: ReferralTotals = {
    ref,
    swaps: totals.swaps + vol.swaps,
    volumeUsd: totals.volumeUsd + vol.volumeUsd,
    feesUsd: totals.feesUsd + feesUsd,
    commissionUsd: totals.commissionUsd + feesUsd * PROTOCOL_FEE_SHARE * REFERRAL_SHARE_OF_PROTOCOL_FEE,
    firstTxAt: totals.firstTxAt ?? now,
    lastTxAt: now,
    lastTx: tx,
  };
  await kv.set(totalsKey(ref), JSON.stringify(next));
  return { status: 'credited', swaps: vol.swaps, volumeUsd: vol.volumeUsd, totals: next };
}
