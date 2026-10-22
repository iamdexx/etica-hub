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
import { hubAddressTxs } from '@/lib/explorerHub';
import { loadVerified } from '@/lib/verified';
import { readPairInfo, type PairInfo } from '@/lib/pairInfo';
import { VerifiedContractView } from '@/components/explorer/VerifiedContractView';
import { ContractInteractionView } from '@/components/explorer/ContractInteractionView';
import {
  formatTokenAmount,
  loadAddressTokenTransfers,
  readTokenMetadata,
  resolveTokenInfos,
  type AddressTokenTransfer,
} from '@/lib/token';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const MAINNET_CHAIN_ID = 61803;
// Width of the recent-tx scan window on the address page. Kept in sync with
// the hard cap inside `scanRecentTxs` so the UI text never advertises a
// larger range than we actually walk. Raising this above ~200 means raising
// the hard cap too, which increases worst-case RPC fan-out per request.
const RECENT_SCAN_BLOCKS = 200n;
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
  const [nativeBalance, code, etxBalance, etiBalance, wegazBalance, head] = await Promise.all([
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
  const verified = isContract ? loadVerified(addr) : null;
  // Probe ERC-20 metadata only for contracts — an EOA has no code to query
  // and the reads would all revert. Returns null for any non-token contract.
  const [tokenMetadata, pairInfo] = isContract
    ? await Promise.all([readTokenMetadata(client, addr), readPairInfo(client, addr)])
    : [null, null];

  // Bounded recent-tx scan: walk backwards at most RECENT_SCAN_BLOCKS looking
  // for txs involving this address. Cheap for active wallets, degrades
  // gracefully for quiet ones (empty list). No indexer required.
  //
  // ERC-20 transfers are scanned separately over a wider TOKEN_LOG_SCAN_BLOCKS
  // window via two eth_getLogs calls (outbound + inbound Transfer), then we
  // probe metadata once per unique emitting contract.
  // Prefer the self-hosted full-chain index (complete history, newest first);
  // fall back to the bounded RPC scan when it is unreachable.
  const [indexed, tokenTransfers] = await Promise.all([
    hubAddressTxs(addrLower, 1, 25),
    loadAddressTokenTransfers(client, addr, head),
  ]);
  const recent = indexed
    ? indexed.txs.map((tx) => ({
        ...tx,
        counterparty: tx.from.toLowerCase() === addrLower ? (tx.to ?? tx.contractAddress) : tx.from,
      }))
    : await scanRecentTxs(client, addr, head);
  const historyNote = indexed
    ? indexed.total != null
      ? `${indexed.total.toLocaleString()} total · newest 25`
      : 'full history · newest 25'
    : `last ${RECENT_SCAN_BLOCKS.toString()} blocks`;
  const tokenInfos = await resolveTokenInfos(
    client,
    tokenTransfers.map((t) => t.token),
  );

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
          {verified ? (
            <span
              className="ml-3 inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 align-middle text-[10px] uppercase tracking-wider text-emerald-300"
              title={`Source verified · ${verified.name}`}
            >
              <span aria-hidden>✓</span> Verified
            </span>
          ) : null}
          {tokenMetadata ? (
            <span
              className="ml-2 inline-flex items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 align-middle text-[10px] uppercase tracking-wider text-sky-300"
              title={`ERC-20 · ${tokenMetadata.name}`}
            >
              ERC-20
            </span>
          ) : null}
          {pairInfo ? (
            <span
              className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 align-middle text-[10px] uppercase tracking-wider text-emerald-300"
              title={pairInfo.direct ? 'EticaSwap Direct (V5) window' : 'EticaSwap V2 pair'}
            >
              {pairInfo.direct ? 'Direct window' : 'Pair'}
            </span>
          ) : null}
        </h1>
        <p className="break-all font-mono text-xs text-white/50">{addr}</p>
        {tokenMetadata ? (
          <p className="text-xs">
            <Link
              href={`/explorer/token/${addr}`}
              className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-sky-200 hover:bg-sky-400/20"
            >
              View as token: {tokenMetadata.symbol} →
            </Link>
          </p>
        ) : null}
      </section>

      {pairInfo ? <PairPanel addr={addr} info={pairInfo} /> : null}

      <section className="grid gap-3 surface p-5 text-sm md:grid-cols-2">
        <Field label="EGAZ balance">{formatEgaz(nativeBalance)} EGAZ</Field>
        <Field label="ETX balance">
          {d?.etx && d.etx !== ZERO ? formatEgaz(etxBalance) : '—'} ETX
        </Field>
        <Field label="ETI balance">
          {ext?.eti && ext.eti !== ZERO ? formatEgaz(etiBalance) : '—'} ETI
        </Field>
        <Field label="EGAZ in pool form (ERC-20)">
          {d?.wegaz && d.wegaz !== ZERO ? formatEgaz(wegazBalance) : '—'} EGAZ
        </Field>
        <Field label="Type">{isContract ? 'Contract' : 'Externally-owned account'}</Field>
        <Field label="Code size">{isContract ? `${(code!.length - 2) / 2} bytes` : '—'}</Field>
      </section>

      {verified ? <VerifiedContractView manifest={verified} /> : null}

      {verified ? <ContractInteractionView address={addr} abi={verified.abi} /> : null}

      <section className="surface p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Transactions</h2>
          <span className="text-xs text-white/40">{historyNote}</span>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-white/50">
            {indexed
              ? 'No transactions involving this address in the indexed history.'
              : `No transactions involving this address in the last ${RECENT_SCAN_BLOCKS.toString()} blocks (full-history index unavailable).`}
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

      <TokenTransfersSection transfers={tokenTransfers} tokenInfos={tokenInfos} viewer={addr} />
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
      client.getBlock({ blockNumber: n, includeTransactions: true }).catch(() => null),
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

function PairPanel({ addr, info }: { addr: string; info: PairInfo }) {
  const t0 = info.tokens.get(info.token0.toLowerCase());
  const t1 = info.tokens.get(info.token1.toLowerCase());
  const sym0 = t0?.symbol ?? 'token0';
  const sym1 = t1?.symbol ?? 'token1';
  const amt = (v: bigint, t?: { decimals: number }) => formatTokenAmount(v, t?.decimals ?? 18);
  return (
    <section className="surface space-y-3 p-5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-white">
          {sym0} / {sym1}{' '}
          <span className="text-xs font-normal text-white/50">
            {info.direct ? 'EticaSwap Direct (V5) window' : 'EticaSwap V2 pair'}
          </span>
        </h2>
        <div className="flex gap-3 text-xs">
          <Link
            href={info.direct ? '/swap?v=v5' : '/swap'}
            className="text-emerald-300 hover:underline"
          >
            Trade →
          </Link>
          <Link href={`/api/v1/pairs/${addr}`} className="text-emerald-300 hover:underline">
            JSON →
          </Link>
        </div>
      </div>
      {info.direct ? (
        <p className="text-xs leading-5 text-white/55">
          This window holds no tokens of its own: its liquidity is ETX hub LP and every swap settles
          on the ETX hub pools, so the token balances below read zero. The reserves here are the
          hub-backed view that trackers and aggregators should read (standard token0 / token1 /
          getReserves, Swap and Sync events).
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={`token0 · ${sym0}`}>
          <Link href={`/explorer/token/${info.token0}`} className="font-mono hover:underline">
            {info.token0}
          </Link>
        </Field>
        <Field label={`token1 · ${sym1}`}>
          <Link href={`/explorer/token/${info.token1}`} className="font-mono hover:underline">
            {info.token1}
          </Link>
        </Field>
        <Field label={`Reserve ${sym0}`}>
          {amt(info.reserve0, t0)} {sym0}
        </Field>
        <Field label={`Reserve ${sym1}`}>
          {amt(info.reserve1, t1)} {sym1}
        </Field>
        <Field label="LP supply">{formatTokenAmount(info.totalSupply, 18)}</Field>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-eyebrow text-white/45">{label}</div>
      <div className="mt-0.5 break-all text-sm text-white/80">{children}</div>
    </div>
  );
}

function TokenTransfersSection({
  transfers,
  tokenInfos,
  viewer,
}: {
  transfers: ReadonlyArray<AddressTokenTransfer>;
  tokenInfos: Map<string, { symbol: string; decimals: number }>;
  viewer: `0x${string}`;
}) {
  const viewerLower = viewer.toLowerCase();
  return (
    <section className="surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Token transfers</h2>
        <span className="text-xs text-white/40">recent</span>
      </div>
      {transfers.length === 0 ? (
        <p className="text-sm text-white/50">
          No ERC-20 Transfer events involving this address in the indexed window.
        </p>
      ) : (
        <ul className="space-y-2">
          {transfers.map((t) => {
            const isMint = t.from.toLowerCase() === '0x0000000000000000000000000000000000000000';
            const isBurn = t.to.toLowerCase() === '0x0000000000000000000000000000000000000000';
            const dir =
              isMint && t.to.toLowerCase() === viewerLower
                ? 'mint'
                : isBurn && t.from.toLowerCase() === viewerLower
                  ? 'burn'
                  : t.from.toLowerCase() === viewerLower
                    ? 'out'
                    : 'in';
            const info = tokenInfos.get(t.token.toLowerCase());
            const tokenLabel = addressLabel(t.token) ?? info?.symbol ?? shortAddress(t.token);
            const amount = info
              ? `${formatTokenAmount(t.value, info.decimals)} ${info.symbol}`
              : t.value.toString();
            const counterparty = t.from.toLowerCase() === viewerLower ? t.to : t.from;
            const dirClass =
              dir === 'in' || dir === 'mint'
                ? 'rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300'
                : dir === 'out' || dir === 'burn'
                  ? 'rounded-full bg-rose-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-300'
                  : 'rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70';
            return (
              <li
                key={`${t.txHash}:${t.logIndex}`}
                className="rounded-lg border border-white/5 bg-white/[0.01] px-3 py-2 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className={dirClass}>{dir}</span>
                    <Link
                      href={`/explorer/tx/${t.txHash}`}
                      className="font-mono text-brand-accent hover:underline"
                    >
                      {shortHash(t.txHash)}
                    </Link>
                  </div>
                  <span className="text-white/70">{amount}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-white/50">
                  <span>token</span>
                  <Link
                    href={`/explorer/token/${t.token}`}
                    className="font-mono text-white/80 hover:underline"
                  >
                    {tokenLabel}
                  </Link>
                  <span>·</span>
                  <span>
                    {dir === 'in' || dir === 'mint' ? 'from' : 'to'}{' '}
                    {isMint && dir === 'mint' ? (
                      <span className="text-white/60">mint</span>
                    ) : isBurn && dir === 'burn' ? (
                      <span className="text-white/60">burn</span>
                    ) : (
                      <Link
                        href={`/explorer/address/${counterparty}`}
                        className="font-mono text-white/80 hover:underline"
                      >
                        {addressLabel(counterparty) ?? shortAddress(counterparty)}
                      </Link>
                    )}
                  </span>
                  <span>·</span>
                  <span>block</span>
                  <Link
                    href={`/explorer/block/${t.blockNumber.toString()}`}
                    className="font-mono text-white/80 hover:underline"
                  >
                    #{t.blockNumber.toString()}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
