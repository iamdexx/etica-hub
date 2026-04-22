import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAddress, isAddress } from 'viem';
import {
  addressLabel,
  explorerClient,
  formatAgo,
  shortAddress,
  shortHash,
} from '@/lib/explorer';
import {
  formatTokenAmount,
  loadTokenRecentTransfers,
  readTokenMetadata,
  uniqueAddressesFromTransfers,
  type TokenTransfer,
} from '@/lib/token';
import { loadVerified } from '@/lib/verified';
import { VerifiedContractView } from '@/components/explorer/VerifiedContractView';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

interface TokenPageProps {
  params: Promise<{ addr: string }>;
}

export default async function TokenPage({ params }: TokenPageProps) {
  const { addr: raw } = await params;
  if (!isAddress(raw, { strict: false })) notFound();
  const addr = getAddress(raw);
  const client = explorerClient();

  // The token page should only render for actual ERC-20 contracts. Anything
  // else (EOA, non-token contract, call-revert) falls through to the
  // generic address page so the user still gets useful output rather than
  // a hard 404.
  const [code, metadata, head] = await Promise.all([
    client.getCode({ address: addr }).catch(() => undefined),
    readTokenMetadata(client, addr),
    client.getBlockNumber(),
  ]);

  const isContract = typeof code === 'string' && code !== '0x';
  if (!isContract || !metadata) {
    // Not a token — redirect-style fallback (no HTTP 3xx, just a visible
    // "open address page" affordance so crawlers and humans both get
    // something useful).
    return (
      <div className="space-y-6">
        <nav className="text-xs text-white/50">
          <Link href="/explorer" className="hover:underline">
            Explorer
          </Link>
          <span className="px-1">/</span>
          <span>Token {shortAddress(addr, 6)}</span>
        </nav>
        <section className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Not a recognizable ERC-20 token
          </h1>
          <p className="text-sm text-white/60">
            <span className="break-all font-mono text-white/80">{addr}</span> either has
            no contract code, or its contract does not implement the ERC-20 metadata
            interface. Use the generic address view instead.
          </p>
          <Link
            href={`/explorer/address/${addr}`}
            className="inline-block rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink"
          >
            Open address view →
          </Link>
        </section>
      </div>
    );
  }

  // This is a real ERC-20. Pull the transfer window and verified manifest.
  // `loadTokenRecentTransfers` prefers the indexer (weeks of history) and
  // falls back to a pure RPC window when the data branch is missing, so
  // the page renders something useful in both states.
  const [transfers, verified] = await Promise.all([
    loadTokenRecentTransfers(client, addr, head),
    Promise.resolve(loadVerified(addr)),
  ]);
  const uniqueAddrs = uniqueAddressesFromTransfers(transfers);
  const label = addressLabel(addr);

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">
          Explorer
        </Link>
        <span className="px-1">/</span>
        <span>
          Token {metadata.symbol} {shortAddress(addr, 6)}
        </span>
      </nav>

      <section className="space-y-2">
        <h1 className="break-all text-2xl font-semibold tracking-tight md:text-3xl">
          <span className="text-brand-accent">{metadata.name}</span>
          <span className="ml-2 text-sm font-normal text-white/60">
            ({metadata.symbol})
          </span>
          {verified ? (
            <span
              className="ml-3 inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 align-middle text-[10px] uppercase tracking-wider text-emerald-300"
              title={`Source verified · ${verified.name}`}
            >
              <span aria-hidden>✓</span> Verified
            </span>
          ) : null}
        </h1>
        <p className="break-all font-mono text-xs text-white/50">
          <Link href={`/explorer/address/${addr}`} className="hover:underline">
            {addr}
          </Link>
          {label ? <span className="ml-2 text-white/40">· {label}</span> : null}
        </p>
      </section>

      <section className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm md:grid-cols-2">
        <Field label="Total supply">
          {formatTokenAmount(metadata.totalSupply, metadata.decimals)} {metadata.symbol}
        </Field>
        <Field label="Decimals">{metadata.decimals}</Field>
        <Field label="Active addresses (recent window)">
          {uniqueAddrs > 0 ? uniqueAddrs.toLocaleString() : '—'}
        </Field>
        <Field label="Contract">
          <Link
            href={`/explorer/address/${addr}`}
            className="font-mono text-brand-accent hover:underline"
          >
            {shortAddress(addr, 6)}
          </Link>
        </Field>
      </section>

      {verified ? <VerifiedContractView manifest={verified} /> : null}

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent transfers</h2>
          <span className="text-xs text-white/40">newest first</span>
        </div>
        {transfers.length === 0 ? (
          <p className="text-sm text-white/50">
            No Transfer events found for this token yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {transfers.map((t) => (
              <TransferRow key={`${t.txHash}:${t.logIndex}`} transfer={t} metadata={metadata} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TransferRow({
  transfer,
  metadata,
}: {
  transfer: TokenTransfer;
  metadata: { symbol: string; decimals: number };
}) {
  const fromLabel = addressLabel(transfer.from) ?? shortAddress(transfer.from);
  const toLabel = addressLabel(transfer.to) ?? shortAddress(transfer.to);
  const ZERO = '0x0000000000000000000000000000000000000000';
  const kind =
    transfer.from.toLowerCase() === ZERO
      ? 'mint'
      : transfer.to.toLowerCase() === ZERO
        ? 'burn'
        : 'transfer';
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.01] px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={
              kind === 'mint'
                ? 'rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300'
                : kind === 'burn'
                  ? 'rounded-full bg-rose-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-300'
                  : 'rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70'
            }
          >
            {kind}
          </span>
          <Link
            href={`/explorer/tx/${transfer.txHash}`}
            className="font-mono text-brand-accent hover:underline"
          >
            {shortHash(transfer.txHash)}
          </Link>
        </div>
        <span className="text-white/80">
          {formatTokenAmount(transfer.value, metadata.decimals)} {metadata.symbol}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-white/50">
        <Link
          href={`/explorer/address/${transfer.from}`}
          className="font-mono text-white/80 hover:underline"
        >
          {fromLabel}
        </Link>
        <span>→</span>
        <Link
          href={`/explorer/address/${transfer.to}`}
          className="font-mono text-white/80 hover:underline"
        >
          {toLabel}
        </Link>
        <span>·</span>
        <Link
          href={`/explorer/block/${transfer.blockNumber.toString()}`}
          className="font-mono text-white/80 hover:underline"
        >
          #{transfer.blockNumber.toString()}
        </Link>
      </div>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 break-all text-white/90">{children}</div>
    </div>
  );
}
