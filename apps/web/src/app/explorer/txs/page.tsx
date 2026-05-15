import Link from 'next/link';
import {
  addressLabel,
  explorerClient,
  formatAgo,
  formatEgaz,
  formatTimestamp,
  shortAddress,
  shortHash,
} from '@/lib/explorer';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const BLOCK_WINDOW = 40;
const TX_LIMIT = 80;

export default async function TransactionsPage() {
  const client = explorerClient();
  const head = await client.getBlockNumber();
  const numbers: bigint[] = [];
  for (let i = 0; i < BLOCK_WINDOW && head - BigInt(i) >= 0n; i++) {
    numbers.push(head - BigInt(i));
  }

  const blocks = await Promise.all(
    numbers.map((number) =>
      client.getBlock({ blockNumber: number, includeTransactions: true }).catch(() => null),
    ),
  );

  const txs = blocks
    .flatMap((block) => {
      if (!block) return [];
      return block.transactions.map((tx) =>
        typeof tx === 'string'
          ? {
              hash: tx as `0x${string}`,
              from: null as `0x${string}` | null,
              to: null as `0x${string}` | null,
              value: 0n,
              blockNumber: block.number,
              timestamp: block.timestamp,
            }
          : {
              hash: tx.hash,
              from: tx.from,
              to: tx.to,
              value: tx.value,
              blockNumber: block.number,
              timestamp: block.timestamp,
            },
      );
    })
    .slice(0, TX_LIMIT);

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">Explorer</Link>
        <span className="px-1">/</span>
        <span>Transactions</span>
      </nav>

      <section className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-accent/80">Live public-RPC window</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Transactions</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/60">
            Latest Etica mainnet transactions from recent blocks. This view gives users scanner-style visibility without requiring a private RPC, archive node, or full historical indexer.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Head" value={`#${head.toString()}`} />
          <Stat label="Loaded" value={txs.length.toString()} />
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="grid grid-cols-[1fr_0.7fr_0.8fr] gap-3 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-wider text-white/40 md:grid-cols-[1fr_0.7fr_1fr_1fr_0.8fr_0.7fr]">
          <div>Txn hash</div>
          <div>Block</div>
          <div className="hidden md:block">From</div>
          <div className="hidden md:block">To</div>
          <div className="text-right">Value</div>
          <div className="text-right">Age</div>
        </div>
        {txs.length === 0 ? (
          <p className="px-4 py-6 text-sm text-white/50">No transactions found in the current live window.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {txs.map((tx) => (
              <div key={tx.hash} className="grid grid-cols-[1fr_0.7fr_0.8fr] gap-3 px-4 py-3 text-xs md:grid-cols-[1fr_0.7fr_1fr_1fr_0.8fr_0.7fr] md:items-center">
                <div>
                  <Link href={`/explorer/tx/${tx.hash}`} className="font-mono text-brand-accent hover:underline">
                    {shortHash(tx.hash)}
                  </Link>
                  <div className="mt-1 hidden text-[10px] text-white/35 sm:block">{formatTimestamp(tx.timestamp)}</div>
                </div>
                <div>
                  <Link href={`/explorer/block/${tx.blockNumber}`} className="font-mono text-white/70 hover:text-white hover:underline">
                    #{tx.blockNumber.toString()}
                  </Link>
                </div>
                <div className="hidden md:block">
                  {tx.from ? (
                    <Link href={`/explorer/address/${tx.from}`} className="font-mono text-white/70 hover:text-white hover:underline">
                      {addressLabel(tx.from) ?? shortAddress(tx.from)}
                    </Link>
                  ) : (
                    <span className="text-white/35">—</span>
                  )}
                </div>
                <div className="hidden md:block">
                  {tx.to ? (
                    <Link href={`/explorer/address/${tx.to}`} className="font-mono text-white/70 hover:text-white hover:underline">
                      {addressLabel(tx.to) ?? shortAddress(tx.to)}
                    </Link>
                  ) : (
                    <span className="text-white/50">contract creation</span>
                  )}
                </div>
                <div className="text-right text-white/70">{formatEgaz(tx.value)} EGAZ</div>
                <div className="text-right text-white/50">{formatAgo(tx.timestamp)}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 font-mono text-sm text-brand-accent">{value}</div>
    </div>
  );
}
