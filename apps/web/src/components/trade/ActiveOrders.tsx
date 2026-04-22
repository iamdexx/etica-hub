'use client';

import { useEffect, useState } from 'react';
import { BaseError, formatUnits, type Address, type Hex } from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWalletClient,
  useWriteContract,
} from 'wagmi';
import { DEPLOYMENTS, abis, isSupportedChainId } from '@etica-hub/shared';
import {
  buildCancelAuthMessage,
  listOrders,
  markCancelled,
  resolveOrderbookUrl,
  type StoredOrderView,
} from '@/lib/trading/orderbookClient';
import {
  cancelOrderOnRegistry,
  fetchRegistryOrders,
  getRegistryAddress,
} from '@/lib/trading/registryClient';
import { splitPermit2Nonce } from '@/lib/trading/cancelNonce';

/**
 * "Your open orders" panel. Polls the order-book API every 30s while the
 * page is visible.
 *
 * Cancel flow:
 *   1. User clicks Cancel on a row.
 *   2. We call `permit2.invalidateUnorderedNonces(wordPos, mask)` to burn
 *      the on-chain nonce, making the order unfillable.
 *   3. After the tx confirms we POST `/orders/:hash/cancel` with the tx hash
 *      so the keeper stops trying (and the UI flips the row to `cancelled`
 *      on the next poll).
 *
 * The signed DutchOrder blob stays in our DB for audit but the reactor will
 * revert if anyone tries to land it, so funds are safe even if our API
 * never gets the cancel tx hash.
 */
export function ActiveOrders({ swapperOverride }: { swapperOverride?: Address } = {}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const swapper = swapperOverride ?? address;
  const orderbookUrl = resolveOrderbookUrl();
  const registryAddress = getRegistryAddress(chainId);
  // Registry is the source of truth when it's deployed; otherwise fall back to
  // the off-chain orderbook API. This mirrors the submission-path branch in
  // OrderForm / DcaForm / GridForm so signing and reading use the same store.
  const useRegistry = registryAddress !== null && Boolean(publicClient);
  const [orders, setOrders] = useState<StoredOrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!swapper) return;
    if (!useRegistry && !orderbookUrl) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        if (!swapper) return;
        let list: StoredOrderView[];
        if (useRegistry && publicClient && isSupportedChainId(chainId)) {
          const all = await fetchRegistryOrders({
            publicClient,
            chainId,
            swapper,
          });
          list = all.filter((o) => o.status === 'open').slice(0, 25);
        } else if (orderbookUrl) {
          list = await listOrders(orderbookUrl, { swapper, status: 'open', limit: 25 });
        } else {
          return;
        }
        if (!cancelled) {
          setOrders(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [swapper, orderbookUrl, reloadKey, useRegistry, publicClient, chainId]);

  if (!useRegistry && !orderbookUrl) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/60">
        Order store not configured. Deploy the on-chain <code className="text-white/80">OrderRegistry</code>{' '}
        or set <code className="text-white/80">NEXT_PUBLIC_ORDERBOOK_URL</code>.
      </div>
    );
  }
  if (!swapper) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/60">
        Connect a wallet to see your open orders.
      </div>
    );
  }

  const rows = orders ?? [];
  const permit2 = isSupportedChainId(chainId)
    ? DEPLOYMENTS[chainId].permit2
    : '0x0000000000000000000000000000000000000000';
  const canCancel = permit2 !== '0x0000000000000000000000000000000000000000';

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5">
      <header className="flex items-baseline justify-between border-b border-white/5 px-4 py-3">
        <h2 className="text-sm font-medium text-white/90">Open orders</h2>
        <span className="text-[11px] uppercase tracking-wider text-white/40">
          {loading && rows.length === 0 ? 'Loading…' : `${rows.length} open`}
        </span>
      </header>
      {error ? (
        <div className="px-4 py-3 text-xs text-rose-300/80">Failed to load: {error}</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-white/50">
          {loading ? 'Loading…' : 'No open orders yet. Sign a limit order and it will appear here.'}
        </div>
      ) : (
        <ul className="divide-y divide-white/5">
          {rows.map((o) => (
            <OrderRow
              key={o.orderHash}
              order={o}
              permit2={permit2 as Address}
              canCancel={canCancel}
              orderbookUrl={orderbookUrl}
              useRegistry={useRegistry}
              chainId={chainId}
              onCancelled={() => setReloadKey((k) => k + 1)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface OrderRowProps {
  order: StoredOrderView;
  permit2: Address;
  canCancel: boolean;
  orderbookUrl: string | null;
  useRegistry: boolean;
  chainId: number;
  onCancelled: () => void;
}

function OrderRow({
  order,
  permit2,
  canCancel,
  orderbookUrl,
  useRegistry,
  chainId,
  onCancelled,
}: OrderRowProps) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  // Recompute on every render so the countdown advances on each 30s poll.
  const expiresIn = timeUntil(order.deadline);
  const inAmount = safeFormat(order.input.startAmount);
  const outAmount = safeFormat(order.output.startAmount);
  const isStop = order.strategyType === 'stop';
  const isDca = order.strategyType === 'dca';
  const isGrid = order.strategyType === 'grid';
  const triggerLabel = isStop && order.triggerPrice
    ? `trigger ${order.triggerDirection === 'lte' ? '≤' : '≥'} ${safeFormat(order.triggerPrice)} ETX`
    : null;
  const dcaLabel = (() => {
    if (!isDca || order.dcaIndex === null || order.dcaTotal === null) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const fires =
      order.decayStartTime <= nowSec ? 'active' : `fires ${timeUntil(order.decayStartTime)}`;
    return `leg ${order.dcaIndex + 1}/${order.dcaTotal} · ${fires}`;
  })();
  const gridLabel = (() => {
    if (!isGrid || order.gridIndex === null || order.gridTotal === null) return null;
    const pricePart = order.gridLevelPrice
      ? ` @ ${safeFormat(order.gridLevelPrice)} ETX`
      : '';
    return `level ${order.gridIndex + 1}/${order.gridTotal}${pricePart}`;
  })();
  const badgeClass = isStop
    ? 'border border-amber-400/20 bg-amber-400/10 text-amber-200/80'
    : isDca
      ? 'border border-violet-400/20 bg-violet-400/10 text-violet-200/80'
      : isGrid
        ? 'border border-emerald-400/20 bg-emerald-400/10 text-emerald-200/80'
        : 'border border-sky-400/20 bg-sky-400/10 text-sky-200/80';
  const badgeLabel = isStop ? 'Stop' : isDca ? 'DCA' : isGrid ? 'Grid' : 'Limit';

  const { writeContractAsync, data: cancelTxHash, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({
    hash: cancelTxHash,
    query: { enabled: Boolean(cancelTxHash) },
  });
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  const isSubmitting = Boolean(cancelTxHash) && !receipt.data && !receipt.error;

  // After the permit2 invalidation tx confirms, flip the order to `cancelled`
  // in whichever store is authoritative:
  //   - registry path → call `registry.cancelOrder(orderHash)` so keepers see
  //     an `OrderCancelled` event and the dashboard's next log poll drops it.
  //   - orderbook path → POST `/orders/:hash/cancel` so the keeper skips it.
  //
  // `receipt.isSuccess` only means the RPC returned a receipt — the tx itself
  // may have reverted, in which case the nonce is still valid and we must NOT
  // mark the order cancelled anywhere.
  useEffect(() => {
    if (!receipt.isSuccess || !cancelTxHash || marking) return;
    if (receipt.data?.status === 'reverted') {
      setCancelError('Nonce invalidation tx reverted on-chain. Order is NOT cancelled.');
      return;
    }
    let aborted = false;
    setMarking(true);
    const finalize = async (): Promise<void> => {
      if (useRegistry) {
        if (!walletClient || !address || !isSupportedChainId(chainId)) {
          throw new Error('Wallet session not ready — try again in a moment.');
        }
        await cancelOrderOnRegistry({
          walletClient,
          chainId,
          account: address,
          orderHash: order.orderHash,
        });
      } else {
        if (!orderbookUrl) {
          throw new Error('No order store configured — cannot record cancellation.');
        }
        if (!walletClient || !address) {
          throw new Error('Wallet session not ready — try again in a moment.');
        }
        // Orderbook /cancel requires a personal_sign from the swapper over
        // (orderHash, cancelTxHash) — proves the caller owns the key, not
        // just that they observed the public orderHash.
        const message = buildCancelAuthMessage(order.orderHash, cancelTxHash);
        const cancelSignature = await walletClient.signMessage({
          account: address,
          message,
        });
        await markCancelled(
          orderbookUrl,
          order.orderHash,
          cancelTxHash,
          cancelSignature,
        );
      }
    };
    finalize()
      .then(() => {
        if (aborted) return;
        reset();
        onCancelled();
      })
      .catch((err) => {
        if (!aborted) setCancelError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!aborted) setMarking(false);
      });
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  async function onCancel() {
    setCancelError(null);
    if (!canCancel) {
      setCancelError('Permit2 not yet deployed on this chain.');
      return;
    }
    try {
      const { wordPos, mask } = splitPermit2Nonce(order.nonce);
      await writeContractAsync({
        abi: abis.permit2Abi,
        address: permit2,
        functionName: 'invalidateUnorderedNonces',
        args: [wordPos, mask],
      });
    } catch (err) {
      setCancelError(formatCancelError(err));
    }
  }

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3 text-xs">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${badgeClass}`}
          >
            {badgeLabel}
          </span>
          <span className="font-mono text-white/90">
            {inAmount} {shortToken(order.input.token)} → {outAmount} {shortToken(order.output.token)}
          </span>
        </div>
        <div className="text-white/40">
          hash <code className="text-white/60">{shortHash(order.orderHash)}</code>
          <span className="mx-2 text-white/20">·</span>
          expires {expiresIn}
          {triggerLabel ? (
            <>
              <span className="mx-2 text-white/20">·</span>
              {triggerLabel}
            </>
          ) : null}
          {dcaLabel ? (
            <>
              <span className="mx-2 text-white/20">·</span>
              {dcaLabel}
            </>
          ) : null}
          {gridLabel ? (
            <>
              <span className="mx-2 text-white/20">·</span>
              {gridLabel}
            </>
          ) : null}
        </div>
        {cancelError ? <div className="text-rose-300/80">{cancelError}</div> : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 uppercase tracking-wider text-[10px] text-emerald-200/80">
          {order.status}
        </span>
        <button
          type="button"
          onClick={onCancel}
          disabled={!canCancel || isSubmitting || marking}
          className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[10px] uppercase tracking-wider text-white/70 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSubmitting ? 'Cancelling…' : marking ? 'Finalizing…' : 'Cancel'}
        </button>
      </div>
    </li>
  );
}

function shortHash(hex: Hex): string {
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function shortToken(token: Address): string {
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function safeFormat(raw: string): string {
  try {
    const n = Number(formatUnits(BigInt(raw), 18));
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : raw;
  } catch {
    return raw;
  }
}

function timeUntil(unixSec: number): string {
  const diff = unixSec - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'expired';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function formatCancelError(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
