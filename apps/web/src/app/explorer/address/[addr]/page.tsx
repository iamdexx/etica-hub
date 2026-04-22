import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAddress, isAddress } from 'viem';
import { DEPLOYMENTS, EXTERNAL_ADDRESSES, abis } from '@etica-hub/shared';
import {
  addressLabel,
  explorerClient,
  formatAgo,
  formatEgaz,
  shortAddress,
  shortHash,
} from '@/lib/explorer';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
const RECENT_SCAN_BLOCKS = 500n;
const ZERO = '0x0000000000000000000000000000000000000000';

interface AddressPageProps {
  params: Promise<{ addr: string }>;
}

export default async function AddressPage({ params }: AddressPageProps) {
  const { addr: raw } = await params;
  if (!isAddress(raw, { strict: false })) notFound();
  const addr = getAddress(raw);
  const addrLower = addr.toLowerCase();

  const client = explorerClient();
  const d = DEPLOYMENTS[MAINNET_CHAIN_ID];
  const ext = EXTERNAL_ADDRESSES[MAINNET_CHAIN_ID];

  // Pull the headline stats in parallel: native balance, code (to detect
  // contract vs EOA), and ERC-20 balances for ETX, ETI, WEGAZ. We don't
  // fetch arbitrary tokens — the explorer only knows the protocol-native
  // assets in v1.
  const [
    nativeBalance,
    code,
    etxBalance,
    etiBalance,
    wegazBalance,
    head,
  ] = await Promise.all([
    client.getBalance({ address: addr }),
    client.getCode({ address: addr }).catch(() => undefined),
    d?.etx && d.etx !== ZERO
      ? (client.readContract({
          abi: abis.erc20Abi,
          address: d.etx,
          functionName: 'balanceOf',
          args: [addr],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    ext?.eti && ext.eti !== ZERO
      ? (client.readContract({
          abi: abis.erc20Abi,
          address: ext.eti,
          functionName: 'balanceOf',
          args: [addr],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    d?.wegaz && d.wegaz !== ZERO
      ? (client.readContract({
          abi: abis.erc20Abi,
          address: d.wegaz,
          functionName: 'balanceOf',
          args: [addr],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    client.getBlockNumber(),
  ]);

  const isContract = typeof code === 'string' && code !== '0x';

  // Bounded recent-tx scan: walk backwards at most RECENT_SCAN_BLOCKS looking
  // for txs involving this address. Cheap for active wallets, degrades
  // gracefully for quiet ones (empty list). No indexer required.
  const recent = await scanRecentTxs(client, addr, head);

  const label = addressLabel(addr);

  return (
    <div className="space-y-6">
      <nav className="text-xs text-white/50">
        <Link href="/explorer" className="hover:underline">
          Explorer
        </Link>
        <span className="px-1">/</span>
        <span>Address {shortAddress(addr, 6)}</span>
      </nav>

      <section className="space-y-2">
        <h1 className="break-all text-2xl font-semibold tracking-tight md:text-3xl">
          {label ? (
            <>
              <span className="text-brand-accent">{label}</span>
              <span className="ml-2 text-sm font-normal text-white/50">
                {isContract ? 'contract' : 'account'}
              </span>
            </>
          ) : isContract ? (
            <>
              Contract <span className="text-sm font-normal text-white/50">(unlabeled)</span>
            </>
          ) : (
            <>Account</>
          )}
        </h1>
        <p className="break-all font-mono text-xs text-white/50">{addr}</p>
      </section>

      <section className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm md:grid-cols-2">
        <Field label="EGAZ balance">{formatEgaz(nativeBalance)} EGAZ</Field>
        <Field label="ETX balance">
          {d?.etx && d.etx !== ZERO ? formatEgaz(etxBalance) : '—'} ETX
        </Field>
        <Field label="ETI balance">
          {ext?.eti && ext.eti !== ZERO ? formatEgaz(etiBalance) : '—'} ETI
        </Field>
        <Field label="WEGAZ balance">
          {d?.wegaz && d.wegaz !== ZERO ? formatEgaz(wegazBalance) : '—'} WEGAZ
        </Field>
        <Field label="Type">{isContract ? 'Contract' : 'Externally-owned account'}</Field>
        <Field label="Code size">
          {isContract ? `${(code!.length - 2) / 2} bytes` : '—'}
        </Field>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent transactions</h2>
          <span className="text-xs text-white/40">
            last {RECENT_SCAN_BLOCKS.toString()} blocks
          </span>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-white/50">
            No transactions involving this address in the last {RECENT_SCAN_BLOCKS.toString()} blocks.
            Full history requires an indexer (not shipped in v1).
          </p>
        ) : (
          <ul className="space-y-2">
            {recent.map((tx) => {
              const dir =
                tx.from.toLowerCase() === addrLower && tx.to?.toLowerCase() === addrLower
                  ? 'self'
                  : tx.from.toLowerCase() === addrLower
                    ? 'out'
                    : 'in';
              return (
                <li
                  key={tx.hash}
                  className="rounded-lg border border-white/5 bg-white/[0.01] px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          dir === 'in'
                            ? 'rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300'
                            : dir === 'out'
                              ? 'rounded-full bg-rose-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-300'
                              : 'rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70'
                        }
                      >
                        {dir}
                      </span>
                      <Link
                        href={`/explorer/tx/${tx.hash}`}
                        className="font-mono text-brand-accent hover:underline"
                      >
                        {shortHash(tx.hash)}
                      </Link>
                    </div>
                    <span className="text-white/50">{formatEgaz(tx.value)} EGAZ</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-white/50">
                    <span>block</span>
                    <Link
                      href={`/explorer/block/${tx.blockNumber.toString()}`}
                      className="font-mono text-white/80 hover:underline"
                    >
                      #{tx.blockNumber.toString()}
                    </Link>
                    <span>·</span>
                    <span>{formatAgo(tx.timestamp)}</span>
                    <span>·</span>
                    <span>
                      {dir === 'in' ? 'from' : 'to'}{' '}
                      {tx.counterparty ? (
                        <Link
                          href={`/explorer/address/${tx.counterparty}`}
                          className="font-mono text-white/80 hover:underline"
                        >
                          {addressLabel(tx.counterparty) ?? shortAddress(tx.counterparty)}
                        </Link>
                      ) : (
                        'contract creation'
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

async function scanRecentTxs(
  client: ReturnType<typeof explorerClient>,
  addr: `0x${string}`,
  head: bigint,
): Promise<
  Array<{
    hash: `0x${string}`;
    from: `0x${string}`;
    to: `0x${string}` | null;
    counterparty: `0x${string}` | null;
    value: bigint;
    blockNumber: bigint;
    timestamp: bigint;
  }>
> {
  const addrLower = addr.toLowerCase();
  const from = head > RECENT_SCAN_BLOCKS ? head - RECENT_SCAN_BLOCKS : 0n;
  const numbers: bigint[] = [];
  for (let n = head; n >= from; n--) {
    numbers.push(n);
    if (numbers.length >= 200) break; // hard cap so a bad RPC can't hang us
  }
  // Pull blocks with txs inlined in parallel — bounded at 200 calls.
  const blocks = await Promise.all(
    numbers.map((n) =>
      client
        .getBlock({ blockNumber: n, includeTransactions: true })
        .catch(() => null),
    ),
  );
  const out: Array<{
    hash: `0x${string}`;
    from: `0x${string}`;
    to: `0x${string}` | null;
    counterparty: `0x${string}` | null;
    value: bigint;
    blockNumber: bigint;
    timestamp: bigint;
  }> = [];
  for (const b of blocks) {
    if (!b) continue;
    for (const tx of b.transactions) {
      if (typeof tx === 'string') continue;
      const matchesFrom = tx.from.toLowerCase() === addrLower;
      const matchesTo = tx.to?.toLowerCase() === addrLower;
      if (!matchesFrom && !matchesTo) continue;
      out.push({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        counterparty: matchesFrom ? tx.to : tx.from,
        value: tx.value,
        blockNumber: b.number,
        timestamp: b.timestamp,
      });
      if (out.length >= 25) return out;
    }
  }
  return out;
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
