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

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const HOME_BLOCKS = 15;

const NAV_ITEMS = [
  { href: '/explorer/blocks', label: 'Blocks' },
  { href: '/explorer/txs', label: 'Transactions' },
  { href: '/explorer/contracts', label: 'Contracts' },
  { href: '/explorer/tokens', label: 'Tokens' },
  { href: '/explorer/verify', label: 'Verify Contract' },
  { href: '/explorer/deploy', label: 'Deploy Contract' },
  { href: '/explorer/gas', label: 'Gas Tracker' },
];

async function loadHomeData() {
  const client = explorerClient();
  const head = await client.getBlockNumber();
  const numbers: bigint[] = [];
  for (let i = 0; i < HOME_BLOCKS && head - BigInt(i) >= 0n; i++) numbers.push(head - BigInt(i));

  const blocks = await Promise.all(
    numbers.map((n) => client.getBlock({ blockNumber: n, includeTransactions: true })),
  );

  const latestTxs = blocks
    .flatMap((b) =>
      b.transactions.map((tx) =>
        typeof tx === 'string'
          ? { hash: tx as `0x${string}`, from: null, to: null, value: 0n, blockNumber: b.number, timestamp: b.timestamp }
          : { hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, blockNumber: b.number, timestamp: b.timestamp },
      ),
    )
    .slice(0, HOME_BLOCKS);

  const totalTxs = blocks.reduce((sum, block) => sum + block.transactions.length, 0);
  const avgGasUsed = blocks.length ? blocks.reduce((sum, block) => sum + block.gasUsed, 0n) / BigInt(blocks.length) : 0n;
  const avgTxsPerBlock = blocks.length ? totalTxs / blocks.length : 0;
  const latestBlock = blocks[0];
  const oldestBlock = blocks[blocks.length - 1];
  const seconds = latestBlock && oldestBlock ? Number(latestBlock.timestamp - oldestBlock.timestamp) || 1 : 1;
  const tps = totalTxs / seconds;
  const utilization = latestBlock?.gasLimit ? Number((avgGasUsed * 10000n) / latestBlock.gasLimit) / 100 : 0;
  return { head, blocks, latestTxs, totalTxs, avgGasUsed, avgTxsPerBlock, tps, utilization };
}

async function handleSearch(formData: FormData): Promise<void> {
  'use server';
  const q = formData.get('q');
  if (typeof q !== 'string') return;
  const resolved = resolveSearchQuery(q);
  if (resolved.path) redirect(resolved.path);
  redirect(`/explorer?error=${encodeURIComponent(resolved.reason ?? 'not found')}`);
}

interface ExplorerHomeProps {
  searchParams?: Promise<{ error?: string }>;
}

export default async function ExplorerHome({ searchParams }: ExplorerHomeProps) {
  const params = (await searchParams) ?? {};
  const { head, blocks, latestTxs, totalTxs, avgGasUsed, avgTxsPerBlock, tps, utilization } = await loadHomeData();

  return (
    <div className="space-y-5 text-sm">
      <section className="overflow-hidden rounded-xl border border-white/10 bg-[#07120f] shadow-2xl shadow-emerald-950/20">
        <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.18),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] px-4 py-5 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider text-emerald-300/80">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
                  Etica Mainnet
                </span>
                <span>Chain 61803</span>
                <span>Head #{head.toString()}</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
                EticaHub <span className="text-brand-accent">Scan</span>
              </h1>
              <p className="max-w-3xl text-xs leading-5 text-white/60 md:text-sm">
                Etherscan-style explorer and EticaHub terminal for blocks, transactions, accounts, tokens, contracts, deployment, verification, and live network analytics.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer/deploy" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Deploy Contract</Link>
              <Link href="/explorer/verify" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/80 hover:bg-white/10">Verify Contract</Link>
            </div>
          </div>

          <form action={handleSearch} className="mt-5 flex overflow-hidden rounded-lg border border-emerald-400/30 bg-black/35 shadow-lg shadow-emerald-950/20">
            <input
              name="q"
              placeholder="Search by Address / Txn Hash / Block / Token"
              className="min-w-0 flex-1 bg-transparent px-4 py-3 text-sm text-white placeholder-white/35 outline-none"
            />
            <button type="submit" className="bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90">
              Search
            </button>
          </form>
          {params.error ? <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">{params.error}</p> : null}
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-white/10 bg-black/20 px-3 py-2 text-xs">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className="shrink-0 rounded-md px-3 py-2 text-white/65 hover:bg-white/10 hover:text-white">
              {item.label}
            </Link>
          ))}
        </div>

        <div className="grid border-b border-white/10 bg-white/[0.015] sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Latest Block" value={`#${head.toString()}`} sub="public RPC live" href={`/explorer/block/${head.toString()}`} />
          <Metric label="Txs in Window" value={totalTxs.toString()} sub={`last ${HOME_BLOCKS} blocks`} href="/explorer/txs" />
          <Metric label="Avg Gas Used" value={avgGasUsed.toString()} sub="recent block avg" href="/explorer/gas" />
          <Metric label="Native Gas" value="EGAZ" sub="Etica mainnet" href="/explorer/tokens" />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <TerminalMetric title="TPS" value={tps.toFixed(3)} hint="bounded live window" />
        <TerminalMetric title="Avg tx / block" value={avgTxsPerBlock.toFixed(1)} hint={`${HOME_BLOCKS} block sample`} />
        <TerminalMetric title="Utilization" value={`${utilization.toFixed(1)}%`} hint="avg gas used / limit" />
        <TerminalMetric title="Tooling" value="Deploy + Verify" hint="in-app contract flow" />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[#07120f]">
          <TableHeader title="Latest Blocks" href="/explorer/blocks" />
          <div className="divide-y divide-white/5">
            {blocks.map((block) => (
              <div key={block.hash} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3 hover:bg-white/[0.025] sm:grid-cols-[0.9fr_1fr_auto]">
                <div>
                  <Link href={`/explorer/block/${block.number}`} className="font-mono text-brand-accent hover:underline">#{block.number.toString()}</Link>
                  <div className="mt-1 text-[11px] text-white/40">{formatAgo(block.timestamp)}</div>
                </div>
                <div className="hidden min-w-0 text-xs text-white/55 sm:block">
                  <span className="text-white/35">Fee recipient </span>
                  <Link href={`/explorer/address/${block.miner}`} className="font-mono text-white/70 hover:text-white hover:underline">
                    {addressLabel(block.miner) ?? shortAddress(block.miner)}
                  </Link>
                  <div className="mt-1 text-[11px] text-white/35">{formatTimestamp(block.timestamp)}</div>
                </div>
                <div className="text-right text-xs">
                  <div className="text-white/70">{block.transactions.length} txns</div>
                  <div className="mt-1 font-mono text-[11px] text-white/35">gas {block.gasUsed.toString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-white/10 bg-[#07120f]">
          <TableHeader title="Latest Transactions" href="/explorer/txs" />
          {latestTxs.length === 0 ? (
            <p className="px-4 py-6 text-xs text-white/45">No transactions in the current live window.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {latestTxs.map((tx) => (
                <div key={tx.hash} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3 hover:bg-white/[0.025] sm:grid-cols-[0.9fr_1fr_auto]">
                  <div>
                    <Link href={`/explorer/tx/${tx.hash}`} className="font-mono text-brand-accent hover:underline">{shortHash(tx.hash)}</Link>
                    <div className="mt-1 text-[11px] text-white/40">{formatAgo(tx.timestamp)}</div>
                  </div>
                  <div className="hidden min-w-0 text-xs text-white/55 sm:block">
                    <div>
                      <span className="text-white/35">From </span>
                      {tx.from ? <Link href={`/explorer/address/${tx.from}`} className="font-mono text-white/70 hover:text-white hover:underline">{addressLabel(tx.from) ?? shortAddress(tx.from)}</Link> : '—'}
                    </div>
                    <div className="mt-1">
                      <span className="text-white/35">To </span>
                      {tx.to ? <Link href={`/explorer/address/${tx.to}`} className="font-mono text-white/70 hover:text-white hover:underline">{addressLabel(tx.to) ?? shortAddress(tx.to)}</Link> : <span className="text-white/60">Contract Creation</span>}
                    </div>
                  </div>
                  <div className="text-right text-xs">
                    <div className="text-white/70">{formatEgaz(tx.value)} EGAZ</div>
                    <Link href={`/explorer/block/${tx.blockNumber}`} className="mt-1 block font-mono text-[11px] text-white/35 hover:text-white">#{tx.blockNumber.toString()}</Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <Action href="/explorer/tokens" title="Tokens" body="ETX, ETI, WEGAZ and known EticaHub asset surfaces." />
        <Action href="/explorer/contracts" title="Contracts" body="Known EticaHub contracts, labels, code status, and source verification paths." />
        <Action href="/explorer/deploy" title="Deploy Contract" body="Wallet-native contract deployment and advanced bytecode mode." />
        <Action href="/explorer/verify" title="Verify Contract" body="Sourcify-backed verification flow for Etica contracts." />
      </section>
    </div>
  );
}

function Metric({ label, value, sub, href }: { label: string; value: string; sub: string; href: string }) {
  return (
    <Link href={href} className="border-white/10 px-4 py-4 hover:bg-white/[0.025] sm:border-r">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 truncate font-mono text-lg font-semibold text-white">{value}</div>
      <div className="mt-1 text-[11px] text-white/35">{sub}</div>
    </Link>
  );
}

function TerminalMetric({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#07120f] p-4">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{title}</div>
      <div className="mt-2 font-mono text-xl font-semibold text-white">{value}</div>
      <div className="mt-1 text-[11px] text-white/35">{hint}</div>
    </div>
  );
}

function TableHeader({ title, href }: { title: string; href: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.025] px-4 py-3">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      <Link href={href} className="text-xs text-brand-accent hover:underline">View All</Link>
    </div>
  );
}

function Action({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="rounded-xl border border-white/10 bg-[#07120f] p-4 hover:border-brand-accent/40 hover:bg-brand-accent/[0.04]">
      <div className="text-sm font-semibold text-white">{title}</div>
      <p className="mt-2 text-xs leading-5 text-white/50">{body}</p>
    </Link>
  );
}
