import Link from 'next/link';
import { notFound } from 'next/navigation';
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

interface BlockPageProps {
  params: Promise<{ number: string }>;
}

export default async function BlockPage({ params }: BlockPageProps) {
  const { number } = await params;
  if (!/^\d+$/.test(number)) notFound();
  const client = explorerClient();
  const n = BigInt(number);

  const block = await client
    .getBlock({ blockNumber: n, includeTransactions: true })
    .catch(() => null);
  if (!block) notFound();

  const txs = block.transactions.map((tx) =>
    typeof tx === 'string'
      ? {
          hash: tx,
          from: null as `0x${string}` | null,
          to: null as `0x${string}` | null,
          value: 0n,
          gas: 0n,
        }
      : {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          gas: tx.gas,
        },
  );

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">
          Explorer
        </Link>
        <span className="px-1">/</span>
        <span>Block #{block.number.toString()}</span>
      </nav>

      <section className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Block <span className="text-brand-accent">#{block.number.toString()}</span>
        </h1>
        <p className="text-sm text-white/60">
          {formatTimestamp(block.timestamp)} · {formatAgo(block.timestamp)}
        </p>
      </section>

      <section className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm md:grid-cols-2">
        <Field label="Hash" mono>
          {block.hash}
        </Field>
        <Field label="Parent">
          {block.number > 0n ? (
            <Link
              href={`/explorer/block/${(block.number - 1n).toString()}`}
              className="font-mono text-brand-accent hover:underline"
            >
              {shortHash(block.parentHash)}
            </Link>
          ) : (
            // Genesis has no real parent. parentHash is the zero hash
            // per EIP-3675 / pre-merge chains; rendering as a link would
            // point at /explorer/block/-1 which 404s.
            <span className="font-mono text-white/50">{shortHash(block.parentHash)}</span>
          )}
        </Field>
        <Field label="Miner">
          <Link
            href={`/explorer/address/${block.miner}`}
            className="font-mono text-brand-accent hover:underline"
          >
            {addressLabel(block.miner) ?? shortAddress(block.miner, 6)}
          </Link>
        </Field>
        <Field label="Transactions">{txs.length}</Field>
        <Field label="Gas used">
          {block.gasUsed.toString()} / {block.gasLimit.toString()}
        </Field>
        <Field label="Base fee (wei)">{block.baseFeePerGas?.toString() ?? '—'}</Field>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-3 text-lg font-semibold">Transactions</h2>
        {txs.length === 0 ? (
          <p className="text-sm text-white/50">No transactions in this block.</p>
        ) : (
          <ul className="space-y-2">
            {txs.map((tx) => (
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

      <div className="flex items-center justify-between text-sm">
        {block.number > 0n ? (
          <Link
            href={`/explorer/block/${(block.number - 1n).toString()}`}
            className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 hover:border-white/30"
          >
            ← Block {(block.number - 1n).toString()}
          </Link>
        ) : (
          <span />
        )}
        <Link
          href={`/explorer/block/${(block.number + 1n).toString()}`}
          className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 hover:border-white/30"
        >
          Block {(block.number + 1n).toString()} →
        </Link>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div
        className={`mt-0.5 break-all text-sm text-white/80 ${mono ? 'font-mono' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
