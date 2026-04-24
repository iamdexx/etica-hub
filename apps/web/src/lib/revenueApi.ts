/**
 * Server-side helpers for `/api/v1/revenue` and `/api/v1/liquidity-flow`.
 *
 * Both routes scan EticaSwap V2 pair events from the DEX launch block to
 * head to report lifetime protocol metrics (swap volume → fees, mint/burn
 * activity → liquidity movement). Numbers are computed fresh from logs on
 * every request and cached at the Next.js layer so aggregator polls don't
 * hammer the RPC.
 *
 * Design choices:
 *
 *   - `DEX_LAUNCH_BLOCK` is a chain-specific fact (the block of the first
 *     PairCreated emitted by the factory) and is pinned here rather than
 *     rediscovered on every request. A per-pair scan from this block is
 *     harmless — getLogs returns empty for any pair that didn't exist yet.
 *   - Fee math is fixed by the V2 contract: swappers pay 30bps (0.30%),
 *     which splits 5bps (0.05%) to `feeTo` as auto-minted LP when `_mintFee`
 *     fires and 25bps (0.25%) to existing LPs proportional to their share.
 *     We surface both so "treasury revenue" (5bps + treasury's LP share of
 *     25bps) is explicit.
 *   - POL burned = LP tokens held at `BURN_ADDRESS` (0xdead). This is a
 *     single balance read per pair; we don't need to scan Transfer logs.
 */

import { formatUnits, parseAbiItem, type Address, type PublicClient } from 'viem';
import { BURN_ADDRESS, fetchSwapLogs, priceClient } from './priceApi';

/**
 * Block of the first EticaSwap V2 pair ever created on Etica Mainnet.
 * Used as the `fromBlock` floor for lifetime-since-launch metrics.
 *
 * Rationale for hardcoding: the factory can emit more PairCreated events
 * later, but this block is a fixed historical fact and scanning from it
 * is always correct (just bounded work on RPC). Pairs created later are
 * still captured because we filter by pair address in the inner getLogs.
 */
export const DEX_LAUNCH_BLOCK: bigint = 9_806_997n;

/** V2 pair `Mint(address indexed sender, uint256 amount0, uint256 amount1)`. */
export const MINT_EVENT = parseAbiItem(
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
);

/**
 * V2 pair `Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)`.
 * Emitted when LP tokens are redeemed for proportional reserves (including
 * the harvester's forthcoming `pair.burn(DEAD)` path).
 */
export const BURN_EVENT = parseAbiItem(
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
);

/** Upper bound on blocks per getLogs page — same as the priceApi pager. */
const LOGS_PAGE_BLOCKS_DEFAULT = 10_000n;
const LOGS_PAGE_BLOCKS_MIN = 500n;

/**
 * Generic paginated log fetcher for a single pair + event. Mirrors the
 * exponential-backoff pattern of {@link fetchSwapLogs} so a cold scan
 * across the full launch→head window survives RPC range caps.
 */
async function fetchEventLogs<T extends { amount0?: bigint; amount1?: bigint }>(
  pair: Address,
  event: typeof MINT_EVENT | typeof BURN_EVENT,
  fromBlock: bigint,
  toBlock: bigint,
  client: PublicClient,
): Promise<Array<{ amount0: bigint; amount1: bigint }>> {
  const out: Array<{ amount0: bigint; amount1: bigint }> = [];
  let pageSize = LOGS_PAGE_BLOCKS_DEFAULT;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + pageSize - 1n > toBlock ? toBlock : cursor + pageSize - 1n;
    try {
      const logs = await client.getLogs({
        address: pair,
        event,
        fromBlock: cursor,
        toBlock: end,
      });
      for (const log of logs) {
        const a0 = (log.args as { amount0?: bigint }).amount0 ?? 0n;
        const a1 = (log.args as { amount1?: bigint }).amount1 ?? 0n;
        out.push({ amount0: a0, amount1: a1 });
      }
      cursor = end + 1n;
    } catch (err) {
      if (pageSize <= LOGS_PAGE_BLOCKS_MIN) throw err;
      pageSize = pageSize / 2n;
      if (pageSize < LOGS_PAGE_BLOCKS_MIN) pageSize = LOGS_PAGE_BLOCKS_MIN;
    }
  }
  return out;
}

/** Total (amount0, amount1) across a set of Mint or Burn logs. */
function sumAmounts(
  logs: Array<{ amount0: bigint; amount1: bigint }>,
): { amount0: bigint; amount1: bigint } {
  let a0 = 0n;
  let a1 = 0n;
  for (const l of logs) {
    a0 += l.amount0;
    a1 += l.amount1;
  }
  return { amount0: a0, amount1: a1 };
}

/**
 * Fetch Burn events for `pair` where the `to` recipient matches `recipient`.
 * Uses viem's indexed-arg filter so only the matching subset comes back from
 * the RPC — cheaper than pulling all Burns and filtering client-side.
 *
 * Used by the revenue route to count fee redemptions back to `feeTo`
 * (i.e. protocol revenue that has been *realized* into the treasury
 * wallet, as opposed to still accruing as LP).
 */
export async function fetchBurnLogsToRecipient(
  pair: Address,
  recipient: Address,
  fromBlock: bigint,
  toBlock: bigint,
  client: PublicClient = priceClient(),
): Promise<Array<{ amount0: bigint; amount1: bigint }>> {
  const out: Array<{ amount0: bigint; amount1: bigint }> = [];
  let pageSize = LOGS_PAGE_BLOCKS_DEFAULT;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + pageSize - 1n > toBlock ? toBlock : cursor + pageSize - 1n;
    try {
      const logs = await client.getLogs({
        address: pair,
        event: BURN_EVENT,
        args: { to: recipient },
        fromBlock: cursor,
        toBlock: end,
      });
      for (const log of logs) {
        out.push({
          amount0: log.args.amount0 ?? 0n,
          amount1: log.args.amount1 ?? 0n,
        });
      }
      cursor = end + 1n;
    } catch (err) {
      if (pageSize <= LOGS_PAGE_BLOCKS_MIN) throw err;
      pageSize = pageSize / 2n;
      if (pageSize < LOGS_PAGE_BLOCKS_MIN) pageSize = LOGS_PAGE_BLOCKS_MIN;
    }
  }
  return out;
}

/**
 * Sum Burn amounts where `to == recipient`, split into ETX-side and
 * other-side using the pair's token ordering. Used to surface "realized
 * revenue" on the /api/v1/revenue route.
 */
export async function loadRealizedBurnsToRecipient(
  pair: Address,
  recipient: Address,
  etxIsToken0: boolean,
  fromBlock: bigint,
  toBlock: bigint,
  client: PublicClient = priceClient(),
): Promise<{
  count: number;
  etxWei: bigint;
  otherWei: bigint;
}> {
  const logs = await fetchBurnLogsToRecipient(
    pair,
    recipient,
    fromBlock,
    toBlock,
    client,
  );
  const sum = sumAmounts(logs);
  return {
    count: logs.length,
    etxWei: etxIsToken0 ? sum.amount0 : sum.amount1,
    otherWei: etxIsToken0 ? sum.amount1 : sum.amount0,
  };
}

export interface LifetimeSwapStats {
  /** Gross swap count (1 Swap event = 1 swap). */
  swapCount: number;
  /**
   * ETX-side volume summed across both directions (amountIn + amountOut on
   * the ETX leg). This is how per-pair volume is reported on V2 DEXes.
   */
  etxVolumeWei: bigint;
}

/**
 * Scan all Swap events for `pair` since {@link DEX_LAUNCH_BLOCK} and tally
 * the ETX-side turnover. `etxIsToken0` flags whether the pair stored ETX
 * in slot 0 (determined by lowercase address ordering — V2 invariant).
 */
export async function loadLifetimeSwapStats(
  pair: Address,
  etxIsToken0: boolean,
  toBlock: bigint,
  client: PublicClient = priceClient(),
): Promise<LifetimeSwapStats> {
  const logs = await fetchSwapLogs(pair, DEX_LAUNCH_BLOCK, toBlock, client);
  let etxVolumeWei = 0n;
  for (const l of logs) {
    const side = etxIsToken0
      ? l.amount0In + l.amount0Out
      : l.amount1In + l.amount1Out;
    etxVolumeWei += side;
  }
  return { swapCount: logs.length, etxVolumeWei };
}

export interface LifetimeLiquidityStats {
  /** Count of Mint events (liquidity added). */
  mintCount: number;
  /** Sum of amount0 across every Mint. */
  mintAmount0Wei: bigint;
  /** Sum of amount1 across every Mint. */
  mintAmount1Wei: bigint;
  /** Count of Burn events (liquidity removed). */
  burnCount: number;
  /** Sum of amount0 across every Burn. */
  burnAmount0Wei: bigint;
  /** Sum of amount1 across every Burn. */
  burnAmount1Wei: bigint;
}

/**
 * Scan Mint + Burn events for `pair` since {@link DEX_LAUNCH_BLOCK} in
 * parallel and return per-event-type totals.
 */
export async function loadLifetimeLiquidityStats(
  pair: Address,
  toBlock: bigint,
  client: PublicClient = priceClient(),
): Promise<LifetimeLiquidityStats> {
  const [mintLogs, burnLogs] = await Promise.all([
    fetchEventLogs(pair, MINT_EVENT, DEX_LAUNCH_BLOCK, toBlock, client),
    fetchEventLogs(pair, BURN_EVENT, DEX_LAUNCH_BLOCK, toBlock, client),
  ]);
  const mints = sumAmounts(mintLogs);
  const burns = sumAmounts(burnLogs);
  return {
    mintCount: mintLogs.length,
    mintAmount0Wei: mints.amount0,
    mintAmount1Wei: mints.amount1,
    burnCount: burnLogs.length,
    burnAmount0Wei: burns.amount0,
    burnAmount1Wei: burns.amount1,
  };
}

/**
 * LP-token balance held at the dead address for a pair. Represents
 * protocol-owned liquidity that the harvester has permanently locked
 * by calling `pair.transfer(DEAD, amount)` — value cannot be redeemed
 * but the underlying reserves stay in the pool backing other LPs.
 */
export async function fetchPolBurnedLp(
  pair: Address,
  client: PublicClient = priceClient(),
): Promise<bigint> {
  // The V2 pair contract is itself the LP token — `balanceOf(DEAD)` on the
  // pair address returns the dead-locked LP amount.
  return (await client.readContract({
    abi: [
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ],
    address: pair,
    functionName: 'balanceOf',
    args: [BURN_ADDRESS],
  })) as bigint;
}

// ---- numeric helpers ------------------------------------------------------

/** Convert a wei amount at 18 decimals to a plain number. */
export function toUnits18(wei: bigint): number {
  return Number(formatUnits(wei, 18));
}

/** Multiply an ETX amount by the current USD anchor (null-safe). */
export function etxToUsd(etx: number, etxUsd: number | null): number | null {
  if (etxUsd === null) return null;
  return etx * etxUsd;
}
