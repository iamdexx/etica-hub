import Link from 'next/link';
import {
  addressLabel,
  explorerClient,
  formatAgo,
  formatTimestamp,
  shortAddress,
  shortHash,
} from '@/lib/explorer';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const BLOCK_COUNT = 40;

export default async function BlocksPage() {
  const client = explorerClient();
  const head = await client.getBlockNumber();
  const numbers: bigint[] = [];
  for (let i = 0; i < BLOCK_COUNT && head - BigInt(i) >= 0n; i++) {
    numbers.push(head - BigInt(i));
  }
  const blocks = await Promise.all(
    numbers.map((number) => client.getBlock({ blockNumber: number, includeTransactions: false })),
  );

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">Explorer</Link>
        <span className="px-1">/</span>
        <span>Blocks</span>
      </nav>

      <section className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/[0.02] p-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-accent/80">Eticascan</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Blocks</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Latest Etica mainnet blocks from public RPC. This page intentionally renders a bounded live window instead of requiring an archival indexer.
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm">
          <div className="text-[10px] uppercase tracking-wider text-white/40">Head</div>
          <div className="mt-1 font-mono text-brand-accent">#{head.toString()}</div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-3 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[0.8fr_1fr_1.2fr_0.8fr_0.8fr]">
          <div>Block</div>
          <div>Age</div>
          <div className="hidden md:block">Miner</div>
          <div className="text-right">Txs</div>
          <div className="text-right">Gas used</div>
        </div>
        <div className="divide-y divide-white/5">
          {blocks.map((block) => (
            <div key={block.hash} className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-3 px-4 py-3 text-sm md:grid-cols-[0.8fr_1fr_1.2fr_0.8fr_0.8fr] md:items-center">
              <div>
                <Link href={`/explorer/block/${block.number}`} className="font-mono text-brand-accent hover:underline">
                  #{block.number.toString()}
                </Link>
                <div className="mt-1 font-mono text-[10px] text-white/35">{shortHash(block.hash ?? '0x')}</div>
              </div>
              <div className="text-xs text-white/55">
                <div>{formatAgo(block.timestamp)}</div>
                <div className="mt-1 hidden text-white/35 sm:block">{formatTimestamp(block.timestamp)}</div>
              </div>
              <div className="hidden text-xs text-white/60 md:block">
                <Link href={`/explorer/address/${block.miner}`} className="font-mono hover:text-white hover:underline">
                  {addressLabel(block.miner) ?? shortAddress(block.miner, 6)}
                </Link>
              </div>
              <div className="text-right text-xs text-white/70">{block.transactions.length}</div>
              <div className="text-right font-mono text-xs text-white/55">{block.gasUsed.toString()}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
