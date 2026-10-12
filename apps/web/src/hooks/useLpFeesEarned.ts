'use client';

import { useEffect, useState } from 'react';
import { parseAbiItem, parseEventLogs, type Address, type Hex, type Log } from 'viem';
import { usePublicClient } from 'wagmi';
import { abis } from '@etica-hub/shared';
import {
  computeLpFeesEarned,
  type LpAdd,
  type LpDonation,
  type LpFeesEarned,
  type LpRemove,
} from '@/lib/lpFees';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const SYNC_EVENT = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');
const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);
const MINT_EVENT = parseAbiItem(
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
);
const BURN_EVENT = parseAbiItem(
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
);

interface LpHistory {
  adds: LpAdd[];
  removes: LpRemove[];
  donations: LpDonation[];
  untrackedLpTransfers: boolean;
}

export interface LpFeesState {
  fees: LpFeesEarned | null;
  loading: boolean;
  error: string | null;
}

interface TransferLog {
  blockHash: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  args: { from?: Address; to?: Address; value?: bigint };
}

interface LogPosition {
  blockNumber: bigint;
  logIndex: number;
}

function isAtOrBefore(e: LogPosition, at: LogPosition): boolean {
  return (
    e.blockNumber < at.blockNumber ||
    (e.blockNumber === at.blockNumber && e.logIndex <= at.logIndex)
  );
}

/** Σ plus − Σ minus over the transfers at or before `at` (LP supply or a wallet's LP). */
function balanceAfter(plus: TransferLog[], minus: TransferLog[], at: LogPosition): bigint {
  let bal = 0n;
  for (const e of plus) if (isAtOrBefore(e, at)) bal += e.args.value ?? 0n;
  for (const e of minus) if (isAtOrBefore(e, at)) bal -= e.args.value ?? 0n;
  return bal;
}

/**
 * Per-wallet swap-fee income for one V2 pair, from the wallet's own LP
 * Transfer history (mint = from 0x0, burn = to the pair; farm moves are
 * neutral) joined with the pair's Sync/Burn events in those transactions.
 * History is re-read whenever the wallet's LP balance changes; the live
 * reserves make the figure tick between those points.
 */
export function useLpFeesEarned(params: {
  pair: Address;
  user: Address | undefined;
  farm: Address;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  lpBalance: bigint;
}): LpFeesState {
  const { pair, user, farm, reserve0, reserve1, totalSupply, lpBalance } = params;
  const publicClient = usePublicClient();
  const [history, setHistory] = useState<LpHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicClient || !user) return;
    let cancelled = false;
    setHistory(null);
    setError(null);

    const transfers = (args: { from?: Address; to?: Address }) =>
      publicClient.getLogs({
        address: pair,
        event: TRANSFER_EVENT,
        args,
        fromBlock: 0n,
        toBlock: 'latest',
      });

    (async () => {
      const pairEvents = <
        T extends typeof SYNC_EVENT | typeof SWAP_EVENT | typeof MINT_EVENT | typeof BURN_EVENT,
      >(
        event: T,
      ) => publicClient.getLogs({ address: pair, event, fromBlock: 0n, toBlock: 'latest' });
      const [incoming, outgoing, allMints, allBurns, syncs, swaps, mints, burns] =
        await Promise.all([
          transfers({ to: user }),
          transfers({ from: user }),
          transfers({ from: ZERO }),
          transfers({ to: ZERO }),
          pairEvents(SYNC_EVENT),
          pairEvents(SWAP_EVENT),
          pairEvents(MINT_EVENT),
          pairEvents(BURN_EVENT),
        ]);
      const supplyAt = (at: LogPosition) => balanceAfter(allMints, allBurns, at);

      const farmLc = farm.toLowerCase();
      const pairLc = pair.toLowerCase();
      const mintLogs: TransferLog[] = [];
      const burnLogs: TransferLog[] = [];
      let untracked = false;
      for (const log of incoming) {
        const from = (log.args.from ?? ZERO).toLowerCase();
        if (from === ZERO) mintLogs.push(log);
        else if (from !== farmLc) untracked = true;
      }
      for (const log of outgoing) {
        const to = (log.args.to ?? ZERO).toLowerCase();
        if (to === pairLc) burnLogs.push(log);
        else if (to !== farmLc) untracked = true;
      }

      // Per-block log lookups by hash instead of receipts: the public RPCs
      // don't all serve old receipts, but every one indexes logs.
      const blockLogs = new Map<Hex, Log[]>();
      await Promise.all(
        [...new Set([...mintLogs, ...burnLogs].map((l) => l.blockHash))].map(async (blockHash) => {
          blockLogs.set(blockHash, await publicClient.getLogs({ address: pair, blockHash }));
        }),
      );
      const pairLogsOf = (log: TransferLog) =>
        (blockLogs.get(log.blockHash) ?? []).filter(
          (l) => l.transactionHash === log.transactionHash,
        );

      const adds: LpAdd[] = [];
      for (const log of mintLogs) {
        const pairLogs = pairLogsOf(log);
        const sync = parseEventLogs({ abi: abis.pairAbi, eventName: 'Sync', logs: pairLogs }).at(
          -1,
        );
        if (!sync) continue;
        const lastIndex = Math.max(
          ...pairLogs.map((l) => l.logIndex).filter((i): i is number => i !== null),
        );
        adds.push({
          lp: log.args.value ?? 0n,
          totalSupply: supplyAt({ blockNumber: log.blockNumber, logIndex: lastIndex }),
          reserve0: sync.args.reserve0,
          reserve1: sync.args.reserve1,
        });
      }
      const removes: LpRemove[] = [...new Set(burnLogs.map((l) => l.transactionHash))].flatMap(
        (hash) => {
          const log = burnLogs.find((l) => l.transactionHash === hash)!;
          return parseEventLogs({
            abi: abis.pairAbi,
            eventName: 'Burn',
            logs: pairLogsOf(log),
          }).map((l) => ({ amount0: l.args.amount0, amount1: l.args.amount1 }));
        },
      );
      // A Sync with no Swap/Mint/Burn in its tx is a bare sync() after a
      // direct token transfer to the pair: growth for every holder, no fee.
      const tradeTxs = new Set([...swaps, ...mints, ...burns].map((l) => l.transactionHash));
      const userPlus = incoming.filter((l) => (l.args.from ?? ZERO).toLowerCase() !== farmLc);
      const userMinus = outgoing.filter((l) => (l.args.to ?? ZERO).toLowerCase() !== farmLc);
      const orderedSyncs = [...syncs].sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? a.logIndex - b.logIndex
          : a.blockNumber < b.blockNumber
            ? -1
            : 1,
      );
      const donations: LpDonation[] = [];
      orderedSyncs.forEach((sync, i) => {
        if (i === 0 || tradeTxs.has(sync.transactionHash)) return;
        const prev = orderedSyncs[i - 1];
        const at = { blockNumber: sync.blockNumber, logIndex: sync.logIndex };
        const userLp = balanceAfter(userPlus, userMinus, at);
        if (userLp <= 0n) return;
        donations.push({
          reserve0Before: prev.args.reserve0 ?? 0n,
          reserve1Before: prev.args.reserve1 ?? 0n,
          reserve0After: sync.args.reserve0 ?? 0n,
          reserve1After: sync.args.reserve1 ?? 0n,
          userLp,
          totalSupply: supplyAt(at),
        });
      });
      if (!cancelled) setHistory({ adds, removes, donations, untrackedLpTransfers: untracked });
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'LP history unavailable');
    });

    return () => {
      cancelled = true;
    };
  }, [publicClient, pair, user, farm, lpBalance]);

  if (error) return { fees: null, loading: false, error };
  if (!history) return { fees: null, loading: Boolean(user), error: null };
  return {
    fees: computeLpFeesEarned({ reserve0, reserve1, totalSupply, lpBalance, ...history }),
    loading: false,
    error: null,
  };
}
