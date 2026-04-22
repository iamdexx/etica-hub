import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatUnits, isHex, type Hex } from 'viem';
import { fetchIpfsText, getProposal, resolveChainId, shortAddress } from '@/lib/research';
import { TipWidget } from '@/components/research/TipWidget';
import { SubscribeCard } from '@/components/research/SubscribeCard';

export const revalidate = 60;

function formatTimestamp(ts: bigint): string {
  if (ts === 0n) return '—';
  const d = new Date(Number(ts) * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ hash: string }>;
}) {
  const { hash } = await params;
  if (!isHex(hash) || hash.length !== 66) notFound();

  const chainId = resolveChainId();
  const proposal = await getProposal(hash as Hex, chainId);
  if (!proposal) notFound();

  const ipfsText =
    proposal.ipfs.kind === 'ipfs' ? await fetchIpfsText(proposal.ipfs.cid) : undefined;

  const totalVotes = proposal.forvotes + proposal.againstvotes;
  const forPct = totalVotes === 0n ? 0 : Number((proposal.forvotes * 10_000n) / totalVotes) / 100;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <nav className="text-xs text-white/40">
        <Link href="/research" className="hover:text-white/70">
          ← Research Hub
        </Link>
      </nav>

      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-white/50">
          <span>Proposal #{proposal.id.toString()}</span>
          <span>·</span>
          <span>{proposal.statusLabel}</span>
          {proposal.istie && (
            <>
              <span>·</span>
              <span className="text-amber-300">Tie</span>
            </>
          )}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {proposal.title || <span className="italic text-white/50">(untitled)</span>}
        </h1>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/60">
          <div>
            Disease:{' '}
            <span className="text-white/80">
              {proposal.diseaseName || `chunk #${proposal.chunkId.toString()}`}
            </span>
          </div>
          <div>
            Proposer:{' '}
            <span className="font-mono text-white/80">{shortAddress(proposal.proposer)}</span>
          </div>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          {proposal.description && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-white/60">
                Summary
              </h2>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/90">
                {proposal.description}
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold uppercase tracking-wide text-white/60">
              <span>Full content (IPFS)</span>
              {proposal.ipfs.kind === 'ipfs' && (
                <a
                  href={proposal.ipfs.gatewayUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs normal-case tracking-normal text-white/40 hover:text-white/70"
                >
                  open on IPFS ↗
                </a>
              )}
            </h2>
            {proposal.ipfs.kind === 'empty' ? (
              <p className="text-sm text-white/50">No off-chain content attached.</p>
            ) : proposal.ipfs.kind === 'raw' ? (
              <>
                <p className="text-xs text-white/40">
                  Non-CID payload (likely legacy / inline data):
                </p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-black/30 p-3 text-xs text-white/80">
                  {proposal.ipfs.value}
                </pre>
              </>
            ) : ipfsText === undefined ? (
              <p className="text-sm text-white/50">
                Couldn&apos;t fetch IPFS content from{' '}
                <a
                  href={proposal.ipfs.gatewayUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline hover:text-white"
                >
                  the default gateway
                </a>
                . Try another gateway.
              </p>
            ) : (
              <pre className="max-h-[600px] overflow-auto rounded-lg bg-black/30 p-3 text-xs text-white/90 whitespace-pre-wrap">
                {ipfsText}
              </pre>
            )}
          </div>

          {proposal.freefield && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-white/60">
                Freefield
              </h2>
              <p className="whitespace-pre-wrap break-all text-sm text-white/80">
                {proposal.freefield}
              </p>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-white/60">
              Voting
            </h3>
            <dl className="space-y-2 text-white/80">
              <div className="flex justify-between">
                <dt className="text-white/50">For</dt>
                <dd>{formatUnits(proposal.forvotes, 18)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/50">Against</dt>
                <dd>{formatUnits(proposal.againstvotes, 18)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/50">Voters</dt>
                <dd>{proposal.nbvoters.toString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/50">Starts</dt>
                <dd>{formatTimestamp(proposal.starttime)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/50">Ends</dt>
                <dd>{formatTimestamp(proposal.endtime)}</dd>
              </div>
              {proposal.finalizedTime > 0n && (
                <div className="flex justify-between">
                  <dt className="text-white/50">Finalized</dt>
                  <dd>{formatTimestamp(proposal.finalizedTime)}</dd>
                </div>
              )}
            </dl>
            {totalVotes > 0n && (
              <div className="mt-4">
                <div className="h-2 w-full overflow-hidden rounded-full bg-rose-400/20">
                  <div
                    className="h-full bg-emerald-400/80"
                    style={{ width: `${forPct}%` }}
                    aria-label={`${forPct.toFixed(1)}% for`}
                  />
                </div>
                <p className="mt-1 text-[11px] text-white/40">{forPct.toFixed(1)}% in favor</p>
              </div>
            )}
          </div>

          <TipWidget recipient={proposal.proposer} title={proposal.title} />
          <SubscribeCard />
        </aside>
      </section>
    </div>
  );
}
