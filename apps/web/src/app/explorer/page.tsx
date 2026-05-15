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

// The explorer is inherently live data. Keep it SSR-only so Etica mainnet
// activity feels like a scanner, not a cached landing page.
export const revalidate = 0;
export const dynamic = 'force-dynamic';

const HOME_BLOCKS = 15;

const EXPLORER_MODULES = [
  {
    href: '/explorer/blocks',
    title: 'Blocks',
    subtitle: 'Canonical chain view',
    body: 'Latest Etica blocks, block producers, gas usage, timestamps, and transaction counts.',
  },
  {
    href: '/explorer/txs',
    title: 'Transactions',
    subtitle: 'Newest transfers and calls',
    body: 'Recent native EGAZ transfers, contract calls, values, senders, recipients, and block links.',
  },
  {
    href: '/explorer/contracts',
    title: 'Contracts',
    subtitle: 'Known protocol addresses',
    body: 'EticaHub contracts, verified labels, token contracts, routers, vaults, farms, and core infra.',
  },
  {
    href: '/explorer/dex',
    title: 'DEX',
    subtitle: 'EticaSwap activity',
    body: 'Swap, pool, LP, farms, staking, xETX vault, FeeRouter, and ETX reward surfaces.',
  },
  {
    href: '/explorer/research',
    title: 'Research',
    subtitle: 'DeSci protocol layer',
    body: 'Research proposals, IPFS content, researcher activity, ETI tips, and subscription contract signals.',
  },
  {
    href: '/explorer/bridge',
    title: 'Bridge',
    subtitle: 'ETI / wETI status',
    body: 'Bridge deposits, mint/burn lifecycle, relayer posture, audit gates, and route health.',
  },
];

async function loadHomeData() {
  const client = explorerClient();
  const head = await client.getBlockNumber();

  const numbers: bigint[] = [];
  for (let i = 0; i < HOME_BLOCKS && head - BigInt(i) >= 0n; i++) {
    numbers.push(head - BigInt(i));
  }
  const blocks = await Promise.all(
    numbers.map((n) =>
      client.getBlock({ blockNumber: n, includeTransactions: true }),
    ),
  );

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

  const headBlock = blocks[0] ?? null;
  const totalTxs = blocks.reduce((sum, block) => sum + block.transactions.length, 0);
  const avgGasUsed = blocks.length
    ? blocks.reduce((sum, block) => sum + block.gasUsed, 0n) / BigInt(blocks.length)
    : 0n;

  return { head, blocks, latestTxs, headBlock, totalTxs, avgGasUsed };
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
  const { head, blocks, latestTxs, headBlock, totalTxs, avgGasUsed } = await loadHomeData();

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.16),transparent_36%),rgba(255,255,255,0.02)] p-6 md:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-4">
            <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs uppercase tracking-wider text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
              Eticascan mode · chain 61803 · head #{head.toString()}
            </p>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">
                EticaHub <span className="text-brand-accent">Explorer</span>
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-white/70 md:text-base">
                A full scanner-style view behind the Explorer tab: blocks, transactions,
                accounts, tokens, contracts, EticaSwap, staking, farms, Research Hub, and bridge
                status in one EticaHub-branded shell.
              </p>
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3 text-sm sm:min-w-[360px]">
            <Stat label="Latest block" value={`#${head.toString()}`} />
            <Stat label="Recent txs" value={totalTxs.toString()} />
            <Stat label="Avg gas used" value={avgGasUsed.toString()} />
            <Stat label="Native gas" value="EGAZ" />
          </div>
        </div>

        <form action={handleSearch} className="mt-7 flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/20 p-2 sm:flex-row">
          <input
            name="q"
            placeholder="Search by block number, tx hash, address, or token contract"
            className="w-full rounded-xl border border-transparent bg-white/5 px-4 py-3 text-sm placeholder-white/40 focus:border-brand-accent focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-xl bg-brand-accent px-6 py-3 text-sm font-semibold text-brand-ink hover:opacity-90"
          >
            Search
          </button>
        </form>
        {params.error ? (
          <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm text-amber-200">
            {params.error}
          </p>
        ) : null}
      </section>

      <section className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        {EXPLORER_MODULES.map((module) => (
          <Link
            key={module.href}
            href={module.href}
            className="group rounded-2xl border border-white/10 bg-white/[0.02] p-4 transition hover:border-brand-accent/40 hover:bg-brand-accent/[0.04]"
          >
            <div className="text-xs uppercase tracking-wider text-brand-accent/80">{module.subtitle}</div>
            <div className="mt-2 text-lg font-semibold text-white">{module.title}</div>
            <p className="mt-2 text-xs leading-5 text-white/55">{module.body}</p>
            <div className="mt-4 text-xs text-brand-accent group-hover:underline">Open →</div>
          </Link>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold">Latest blocks</h2>
              <p className="text-xs text-white/45">Eticascan-style block feed</p>
            </div>
            <Link href="/explorer/blocks" className="text-xs text-brand-accent hover:underline">
              View all →
            </Link>
          </div>
          <div className="divide-y divide-white/5">
            {blocks.map((b) => (
              <div key={b.hash} className="grid gap-3 px-5 py-3 text-sm md:grid-cols-[1fr_1fr_0.8fr] md:items-center">
                <div>
                  <Link href={`/explorer/block/${b.number}`} className="font-mono text-brand-accent hover:underline">
                    Block #{b.number.toString()}
                  </Link>
                  <div className="mt-1 text-xs text-white/45">{formatAgo(b.timestamp)} · {formatTimestamp(b.timestamp)}</div>
                </div>
                <div className="text-xs text-white/55">
                  Miner{' '}
                  <Link href={`/explorer/address/${b.miner}`} className="font-mono text-white/80 hover:underline">
                    {addressLabel(b.miner) ?? shortAddress(b.miner)}
                  </Link>
                </div>
                <div className="text-right text-xs text-white/55">
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">{b.transactions.length} txs</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02]">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold">Latest transactions</h2>
              <p className="text-xs text-white/45">Newest activity from recent blocks</p>
            </div>
            <Link href="/explorer/txs" className="text-xs text-brand-accent hover:underline">
              View all →
            </Link>
          </div>
          {latestTxs.length === 0 ? (
            <p className="px-5 py-4 text-sm text-white/50">No transactions in the last {HOME_BLOCKS} blocks.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {latestTxs.map((tx) => (
                <div key={tx.hash} className="px-5 py-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/explorer/tx/${tx.hash}`} className="font-mono text-brand-accent hover:underline">
                      {shortHash(tx.hash)}
                    </Link>
                    <span className="text-white/60">{formatEgaz(tx.value)} EGAZ</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-white/45">
                    <span>From</span>
                    {tx.from ? (
                      <Link href={`/explorer/address/${tx.from}`} className="font-mono text-white/75 hover:underline" title={tx.from}>
                        {addressLabel(tx.from) ?? shortAddress(tx.from)}
                      </Link>
                    ) : (
                      <span>—</span>
                    )}
                    <span>to</span>
                    {tx.to ? (
                      <Link href={`/explorer/address/${tx.to}`} className="font-mono text-white/75 hover:underline" title={tx.to}>
                        {addressLabel(tx.to) ?? shortAddress(tx.to)}
                      </Link>
                    ) : (
                      <span className="text-white/60">contract creation</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <ProtocolCard title="EticaSwap" href="/explorer/dex" items={["Pools", "Swaps", "LP tokens", "FeeRouter"]} />
        <ProtocolCard title="Yield" href="/explorer/dex" items={["MasterChef", "xETXVault", "stETX", "Farms"]} />
        <ProtocolCard title="Research Hub" href="/explorer/research" items={["Proposals", "IPFS", "ETI tips", "Subscriptions"]} />
        <ProtocolCard title="Bridge" href="/explorer/bridge" items={["ETI ↔ wETI", "Relayer", "Audit gate", "Route health"]} />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-xs text-white/60">
        <div className="mb-1 text-sm font-semibold text-white/80">Head block</div>
        <div>
          #{head.toString()} · {formatTimestamp(headBlock?.timestamp ?? 0n)} ·{' '}
          {headBlock ? `mined by ${addressLabel(headBlock.miner) ?? shortAddress(headBlock.miner)}` : '—'}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="mt-1 truncate font-mono text-sm text-white">{value}</div>
    </div>
  );
}

function ProtocolCard({ title, href, items }: { title: string; href: string; items: string[] }) {
  return (
    <Link href={href} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 hover:border-brand-accent/40 hover:bg-brand-accent/[0.04]">
      <div className="text-lg font-semibold">{title}</div>
      <div className="mt-4 flex flex-wrap gap-2">
        {items.map((item) => (
          <span key={item} className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/60">
            {item}
          </span>
        ))}
      </div>
    </Link>
  );
}
