'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatUnits, type Address, type Hex } from 'viem';
import { useAccount } from 'wagmi';
import {
  listOrders,
  resolveOrderbookUrl,
  type StoredOrderView,
} from '@/lib/trading/orderbookClient';

/**
 * Lightweight "your open orders" panel. Polls the order-book API every 30s
 * while the page is visible.
 *
 * Cancel is intentionally a read-only link for now: the Permit2
 * `invalidateUnorderedNonces(wordPos, mask)` call needs a signed tx from the
 * user's wallet, and the orderbook needs the tx hash to update `status`.
 * That flow ships in PR F.2 along with Stop orders — the DB field already
 * exists (`cancelTxHash`) so the read path will light up automatically.
 */
export function ActiveOrders({ swapperOverride }: { swapperOverride?: Address } = {}) {
  const { address } = useAccount();
  const swapper = swapperOverride ?? address;
  const orderbookUrl = resolveOrderbookUrl();
  const [orders, setOrders] = useState<StoredOrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!swapper || !orderbookUrl) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        if (!swapper || !orderbookUrl) return;
        const list = await listOrders(orderbookUrl, { swapper, status: 'open', limit: 25 });
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
  }, [swapper, orderbookUrl]);

  if (!orderbookUrl) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs text-white/60">
        Order book URL not configured. Set <code className="text-white/80">NEXT_PUBLIC_ORDERBOOK_URL</code>.
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
            <OrderRow key={o.orderHash} order={o} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderRow({ order }: { order: StoredOrderView }) {
  const expiresIn = useMemo(() => timeUntil(order.deadline), [order.deadline]);
  const inAmount = safeFormat(order.input.startAmount);
  const outAmount = safeFormat(order.output.startAmount);
  return (
    <li className="flex items-baseline justify-between gap-3 px-4 py-3 text-xs">
      <div className="space-y-0.5">
        <div className="font-mono text-white/90">
          {inAmount} {shortToken(order.input.token)} → {outAmount} {shortToken(order.output.token)}
        </div>
        <div className="text-white/40">
          hash <code className="text-white/60">{shortHash(order.orderHash)}</code>
          <span className="mx-2 text-white/20">·</span>
          expires {expiresIn}
        </div>
      </div>
      <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 uppercase tracking-wider text-[10px] text-emerald-200/80">
        {order.status}
      </span>
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
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86_400)}d`;
}
