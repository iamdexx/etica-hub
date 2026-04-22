import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  explorerClient,
  formatAgo,
  formatEgaz,
  formatTimestamp,
  addressLabel,
  shortAddress,
  shortHash,
  resolveSearchQuery,
} from '@/lib/explorer';

// The explorer is inherently live data. We don't want Vercel to cache a
// rendered "latest blocks" page for the CDN's default 60s because it makes
// the site feel stale. Setting revalidate=0 + dynamic=force-dynamic puts
// every request through SSR.
export const revalidate = 0;
export const dynamic = 'force-dynamic';

const HOME_BLOCKS = 15;

async function loadHomeData() {
  const client = explorerClient();
  const head = await client.getBlockNumber();

  // Pull the latest N blocks with their tx lists inlined. This is 15 RPC
  // calls per page render — fine for homepage-sized traffic.
  const numbers: bigint[] = [];
  for (let i = 0; i < HOME_BLOCKS && head - BigInt(i) >= 0n; i++) {
    numbers.push(head - BigInt(i));
  }
  const blocks = await Promise.all(
    numbers.map((n) =>
      client.getBlock({ blockNumber: n, includeTransactions: true }),
    ),
  );

  // "Latest txs" = the most recent N tx hashes from the head-down window.
  const latestTxs = blocks
    .flatMap((b) =>
      b.transactions.map((tx) =>
        typeof tx === 'string'
          ? { hash: tx as `0x${string}`, from: null, to: null, value: 0n, blockNumber: b.number }
          : {
              hash: tx.hash,
              from: tx.from,
              to: tx.to,
              value: tx.value,
              blockNumber: b.number,
            },
      ),
    )
    .slice(0, HOME_BLOCKS);

  return { head, blocks, latestTxs };
}

async function handleSearch(formData: FormData): Promise<void> {
  'use server';
  const q = formData.get('q');
  if (typeof q !== 'string') return;
  const resolved = resolveSearchQuery(q);
  if (resolved.path) {
    redirect(resolved.path);
  }
  redirect(`/explorer?error=${encodeURIComponent(resolved.reason ?? 'not found')}`);
}

interface ExplorerHomeProps {
  searchParams?: Promise<{ error?: string }>;
}

export default async function ExplorerHome({ searchParams }: ExplorerHomeProps) {
  const params = (await searchParams) ?? {};
  const { head, blocks, latestTxs } = await loadHomeData();
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs uppercase tracking-wider text-emerald-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
          Etica Mainnet · chain 61803 · head #{head.toString()}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Explorer</h1>
        <p className="max-w-2xl text-sm text-white/70">
          Blocks, transactions, and accounts on Etica Mainnet. This is a read-only view
          straight from RPC — no indexer, no database, and no paywall. Known contracts
          are labeled for you.
        </p>
      </section>

      <form action={handleSearch} className="flex flex-col gap-2 sm:flex-row">
        <input
          name="q"
          placeholder="Search by block number, tx hash, or address"
          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm placeholder-white/40 focus:border-brand-accent focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-brand-accent px-5 py-2 text-sm font-medium text-brand-ink hover:opacity-90"
        >
          Search
        </button>
      </form>
      {params.error ? (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm text-amber-200">
          {params.error}
        </p>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Latest blocks</h2>
            <span className="text-xs text-white/40">top {HOME_BLOCKS}</span>
          </div>
          <ul className="space-y-2">
            {blocks.map((b) => (
              <li
                key={b.hash}
                className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.01] px-3 py-2 text-sm"
              >
                <Link
                  href={`/explorer/block/${b.number}`}
                  className="font-mono text-brand-accent hover:underline"
                >
                  #{b.number.toString()}
                </Link>
                <span className="flex-1 text-right text-xs text-white/50">
                  {b.transactions.length} tx · {formatAgo(b.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Latest transactions</h2>
            <span className="text-xs text-white/40">top {HOME_BLOCKS}</span>
          </div>
          {latestTxs.length === 0 ? (
            <p className="text-sm text-white/50">No transactions in the last {HOME_BLOCKS} blocks.</p>
          ) : (
            <ul className="space-y-2">
              {latestTxs.map((tx) => (
                <li
                  key={tx.hash}
                  className="rounded-lg border border-white/5 bg-white/[0.01] px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Link
                      href={`/explorer/tx/${tx.hash}`}
                      className="font-mono text-brand-accent hover:underline"
                    >
                      {shortHash(tx.hash)}
                    </Link>
                    <span className="text-white/50">{formatEgaz(tx.value)} EGAZ</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-white/50">
                    <span>From</span>
                    {tx.from ? (
                      <Link
                        href={`/explorer/address/${tx.from}`}
                        className="font-mono text-white/80 hover:underline"
                        title={tx.from}
                      >
                        {addressLabel(tx.from) ?? shortAddress(tx.from)}
                      </Link>
                    ) : (
                      <span>—</span>
                    )}
                    <span>→</span>
                    {tx.to ? (
                      <Link
                        href={`/explorer/address/${tx.to}`}
                        className="font-mono text-white/80 hover:underline"
                        title={tx.to}
                      >
                        {addressLabel(tx.to) ?? shortAddress(tx.to)}
                      </Link>
                    ) : (
                      <span className="text-white/60">contract creation</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-xs text-white/60">
        <div className="mb-1 text-sm font-semibold text-white/80">Head block</div>
        <div>
          #{head.toString()} · {formatTimestamp(blocks[0]?.timestamp ?? 0n)} ·{' '}
          {blocks[0] ? `mined by ${addressLabel(blocks[0].miner) ?? shortAddress(blocks[0].miner)}` : '—'}
        </div>
      </section>
    </div>
  );
}
