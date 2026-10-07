import type { Address, PublicClient } from 'viem';
import { abis, type FrozenHolder } from '@etica-hub/shared';

/**
 * Supply math shared by the explorer token table and the public supply API.
 *
 * Two numbers are reported for every asset:
 *   - total:       what the chain says exists (ERC-20 `totalSupply()`, or
 *                  cumulative block emission for the native coin);
 *   - circulating: total minus balances held by protocol-frozen holders —
 *                  addresses the node refuses transactions from, so their
 *                  balances can never move again (see `frozenHolders` in
 *                  `EXTERNAL_ADDRESSES`).
 */

/** ETIP-1017 tail emission: a fixed 2 EGAZ per mined block since genesis. */
export const EGAZ_BLOCK_REWARD_WEI = 2n * 10n ** 18n;

/**
 * Lower bound on EGAZ ever emitted at `head`: block rewards only. Uncle
 * inclusion rewards (1/32 of the block reward per uncle) and uncle rewards
 * add a little on top, and the genesis allocation is empty, so the real
 * figure is slightly above this.
 */
export function egazEmittedFloor(head: bigint): bigint {
  return head > 0n ? head * EGAZ_BLOCK_REWARD_WEI : 0n;
}

export interface FrozenBalance {
  holder: FrozenHolder;
  balance: bigint;
}

export interface SupplyBreakdown {
  /** Raw on-chain total (18-decimal wei for every asset we track). */
  total: bigint;
  /** Sum of frozen holder balances, never larger than `total`. */
  frozen: bigint;
  /** `total - frozen`, floored at zero. */
  circulating: bigint;
  frozenBalances: FrozenBalance[];
}

export function breakdownSupply(total: bigint, frozenBalances: FrozenBalance[]): SupplyBreakdown {
  const frozenRaw = frozenBalances.reduce((acc, f) => acc + f.balance, 0n);
  const frozen = frozenRaw > total ? total : frozenRaw;
  return { total, frozen, circulating: total - frozen, frozenBalances };
}

/** Raw wei → float in whole units; good enough for the compact table formatter. */
export function toUnits(raw: bigint, decimals = 18): number {
  return Number(raw) / 10 ** decimals;
}

/** Compact "7.31M" / "131.24k" style formatter for table cells. */
export function formatSupply(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** ERC-20 supply with frozen holders' balances netted out. Read failures count as zero. */
export async function readErc20Supply(
  client: PublicClient,
  token: Address,
  frozenHolders: FrozenHolder[],
): Promise<SupplyBreakdown> {
  const [total, ...balances] = await Promise.all([
    client
      .readContract({ abi: abis.erc20Abi, address: token, functionName: 'totalSupply' })
      .then((v) => v as bigint)
      .catch(() => 0n),
    ...frozenHolders.map((h) =>
      client
        .readContract({ abi: abis.erc20Abi, address: token, functionName: 'balanceOf', args: [h.address] })
        .then((v) => v as bigint)
        .catch(() => 0n),
    ),
  ]);
  return breakdownSupply(
    total,
    frozenHolders.map((holder, i) => ({ holder, balance: balances[i] ?? 0n })),
  );
}

/** Native EGAZ: emission floor at `head` minus frozen holders' native balances. */
export async function readNativeSupply(
  client: PublicClient,
  head: bigint,
  frozenHolders: FrozenHolder[],
): Promise<SupplyBreakdown> {
  const balances = await Promise.all(
    frozenHolders.map((h) => client.getBalance({ address: h.address }).catch(() => 0n)),
  );
  return breakdownSupply(
    egazEmittedFloor(head),
    frozenHolders.map((holder, i) => ({ holder, balance: balances[i] ?? 0n })),
  );
}
