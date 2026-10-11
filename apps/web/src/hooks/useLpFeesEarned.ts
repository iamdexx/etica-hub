'use client';

import { useEffect, useState } from 'react';
import { parseAbiItem, parseEventLogs, type Address, type Hex, type Log } from 'viem';
import { usePublicClient } from 'wagmi';
import { abis } from '@etica-hub/shared';
import { computeLpFeesEarned, type LpAdd, type LpFeesEarned, type LpRemove } from '@/lib/lpFees';

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

interface LpHistory {
  adds: LpAdd[];
  removes: LpRemove[];
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

/** LP total supply after the given log, replayed from the pair's own mint/burn transfers. */
function supplyAfter(supplyEvents: TransferLog[], blockNumber: bigint, logIndex: number): bigint {
  let supply = 0n;
  for (const e of supplyEvents) {
    if (e.blockNumber < blockNumber || (e.blockNumber === blockNumber && e.logIndex <= logIndex)) {
      supply += e.args.from === ZERO ? (e.args.value ?? 0n) : -(e.args.value ?? 0n);
    }
  }
  return supply;
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
      const [incoming, outgoing, allMints, allBurns] = await Promise.all([
        transfers({ to: user }),
        transfers({ from: user }),
        transfers({ from: ZERO }),
        transfers({ to: ZERO }),
      ]);
      const supplyEvents = [...allMints, ...allBurns];

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
          totalSupply: supplyAfter(supplyEvents, log.blockNumber, lastIndex),
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
      if (!cancelled) setHistory({ adds, removes, untrackedLpTransfers: untracked });
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
