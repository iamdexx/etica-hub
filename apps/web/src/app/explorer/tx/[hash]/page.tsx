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

interface TxPageProps {
  params: Promise<{ hash: string }>;
}

export default async function TxPage({ params }: TxPageProps) {
  const { hash } = await params;
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) notFound();
  const client = explorerClient();
  const hashTyped = hash as `0x${string}`;

  // Look up the tx and its receipt in parallel. Both will 404 if the hash is
  // unknown — but a user may paste a *block* hash into the tx page, so we
  // fall back to a block lookup before giving up entirely.
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: hashTyped }).catch(() => null),
    client.getTransactionReceipt({ hash: hashTyped }).catch(() => null),
  ]);

  if (!tx) {
    // Fallback: treat the input as a block hash.
    const block = await client
      .getBlock({ blockHash: hashTyped })
      .catch(() => null);
    if (block) {
      // Redirect by rendering a link instead of calling redirect() — keeps
      // the back button working normally.
      return (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">Matched block, not transaction</h1>
          <p className="text-sm text-white/60">
            The hash <code className="font-mono text-white/80">{hash}</code> belongs to a
            block, not a transaction.
          </p>
          <Link
            href={`/explorer/block/${block.number.toString()}`}
            className="inline-block rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink"
          >
            Open block #{block.number.toString()} →
          </Link>
        </div>
      );
    }
    notFound();
  }

  // `0n` is falsy in JS, so a truthy check here would skip the fetch for a
  // genesis-block tx. Use an explicit null check.
  const block =
    tx.blockNumber != null
      ? await client.getBlock({ blockNumber: tx.blockNumber }).catch(() => null)
      : null;

  const status = receipt ? (receipt.status === 'success' ? 'Success' : 'Failed') : 'Pending';

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">
          Explorer
        </Link>
        <span className="px-1">/</span>
        <span>Tx {shortHash(tx.hash)}</span>
      </nav>

      <section className="space-y-2">
        <h1 className="break-all text-2xl font-semibold tracking-tight md:text-3xl">
          Transaction
        </h1>
        <p className="break-all font-mono text-xs text-white/50">{tx.hash}</p>
      </section>

      <section className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm md:grid-cols-2">
        <Field label="Status">
          <span
            className={
              status === 'Success'
                ? 'text-emerald-300'
                : status === 'Failed'
                  ? 'text-rose-300'
                  : 'text-amber-300'
            }
          >
            {status}
          </span>
        </Field>
        <Field label="Block">
          {tx.blockNumber !== null ? (
            <Link
              href={`/explorer/block/${tx.blockNumber.toString()}`}
              className="font-mono text-brand-accent hover:underline"
            >
              #{tx.blockNumber.toString()}
            </Link>
          ) : (
            '—'
          )}
        </Field>
        <Field label="Timestamp">
          {block ? `${formatTimestamp(block.timestamp)} · ${formatAgo(block.timestamp)}` : '—'}
        </Field>
        <Field label="From">
          <Link
            href={`/explorer/address/${tx.from}`}
            className="font-mono text-brand-accent hover:underline"
          >
            {addressLabel(tx.from) ?? tx.from}
          </Link>
        </Field>
        <Field label="To">
          {tx.to ? (
            <Link
              href={`/explorer/address/${tx.to}`}
              className="font-mono text-brand-accent hover:underline"
            >
              {addressLabel(tx.to) ?? tx.to}
            </Link>
          ) : (
            <span className="text-white/60">Contract creation</span>
          )}
        </Field>
        <Field label="Value">{formatEgaz(tx.value)} EGAZ</Field>
        <Field label="Nonce">{tx.nonce}</Field>
        <Field label="Gas (limit / used)">
          {tx.gas.toString()} / {receipt?.gasUsed.toString() ?? '—'}
        </Field>
        <Field label="Gas price (wei)">
          {tx.gasPrice?.toString() ?? tx.maxFeePerGas?.toString() ?? '—'}
        </Field>
        <Field label="Tx type">{tx.type}</Field>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-2 text-lg font-semibold">Input data</h2>
        {!tx.input || tx.input === '0x' ? (
          <p className="text-sm text-white/50">No calldata (plain value transfer).</p>
        ) : (
          <pre className="max-h-72 overflow-auto rounded-lg border border-white/5 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/70">
            {tx.input}
          </pre>
        )}
      </section>

      {receipt && receipt.logs.length > 0 ? (
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-3 text-lg font-semibold">Events ({receipt.logs.length})</h2>
          <ul className="space-y-3">
            {receipt.logs.map((log, i) => (
              <li
                key={`${log.transactionHash}-${i}`}
                className="rounded-lg border border-white/5 bg-white/[0.01] p-3 text-xs"
              >
                <div className="mb-1 flex items-center justify-between gap-3 text-white/60">
                  <span>Log #{i}</span>
                  <Link
                    href={`/explorer/address/${log.address}`}
                    className="font-mono text-brand-accent hover:underline"
                  >
                    {addressLabel(log.address) ?? shortAddress(log.address)}
                  </Link>
                </div>
                {log.topics.length > 0 ? (
                  <div className="mb-1 font-mono text-[11px] text-white/70">
                    topic0: {shortHash(log.topics[0] as string, 10)}
                    {log.topics.length > 1 ? ` · +${log.topics.length - 1} more` : ''}
                  </div>
                ) : null}
                {log.data && log.data !== '0x' ? (
                  <div className="break-all font-mono text-[11px] text-white/50">
                    data: {log.data.length > 120 ? `${log.data.slice(0, 120)}…` : log.data}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-0.5 break-all text-sm text-white/80">{children}</div>
    </div>
  );
}
