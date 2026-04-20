import Link from 'next/link';
import { PROPOSAL_STATUS_LABEL, ProposalStatus } from '@etica-hub/shared';
import {
  listRecentProposals,
  resolveChainId,
  shortAddress,
  type ProposalSummary,
} from '@/lib/research';

export const metadata = { title: 'Research Hub · EticaHub' };
export const revalidate = 60;

const STATUS_FILTERS: Array<{ label: string; value: 'all' | ProposalStatus }> = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: ProposalStatus.Pending },
  { label: 'Accepted', value: ProposalStatus.Accepted },
  { label: 'Rejected', value: ProposalStatus.Rejected },
];

type SearchParams = { status?: string; q?: string };

function parseStatus(raw: string | undefined): 'all' | ProposalStatus {
  if (!raw || raw === 'all') return 'all';
  const n = Number(raw);
  if (Number.isNaN(n)) return 'all';
  if (n in PROPOSAL_STATUS_LABEL) return n as ProposalStatus;
  return 'all';
}

function applyFilters(
  proposals: ProposalSummary[],
  filter: 'all' | ProposalStatus,
  q: string | undefined,
): ProposalSummary[] {
  const needle = q?.trim().toLowerCase();
  return proposals.filter((p) => {
    if (filter !== 'all' && p.status !== filter) return false;
    if (!needle) return true;
    return (
      p.title.toLowerCase().includes(needle) ||
      p.proposer.toLowerCase().includes(needle) ||
      (p.diseaseName ?? '').toLowerCase().includes(needle)
    );
  });
}

export default async function ResearchPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const statusFilter = parseStatus(params.status);
  const q = params.q;

  const chainId = resolveChainId();
  let proposals: ProposalSummary[] = [];
  let error: string | undefined;
  try {
    proposals = await listRecentProposals(30, chainId);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load proposals';
  }

  const filtered = applyFilters(proposals, statusFilter, q);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Research Hub</h1>
        <p className="text-sm text-white/60">
          Every research proposal submitted to the Etica core contract — pulled live from chain{' '}
          {chainId}, rendered from IPFS. Tip researchers in ETI, or subscribe for curated feeds.
        </p>
      </header>

      <form className="flex flex-col gap-3 sm:flex-row sm:items-center" role="search">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => {
            const active =
              (statusFilter === 'all' && f.value === 'all') || statusFilter === f.value;
            const href =
              f.value === 'all'
                ? q
                  ? `/research?q=${encodeURIComponent(q)}`
                  : '/research'
                : q
                  ? `/research?status=${f.value}&q=${encodeURIComponent(q)}`
                  : `/research?status=${f.value}`;
            return (
              <Link
                key={f.label}
                href={href}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  active
                    ? 'border-white/30 bg-white/10 text-white'
                    : 'border-white/10 text-white/60 hover:border-white/20 hover:text-white'
                }`}
              >
                {f.label}
              </Link>
            );
          })}
        </div>
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search title, disease, or proposer…"
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
        />
        {statusFilter !== 'all' && (
          <input type="hidden" name="status" value={String(statusFilter)} />
        )}
      </form>

      {error ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-200">
          Couldn&apos;t reach the Etica RPC to load proposals. {error}
        </div>
      ) : proposals.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-8 text-center text-sm text-white/50">
          No proposals on this chain yet.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-8 text-center text-sm text-white/50">
          No proposals match your filters.
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((p) => (
            <li key={p.hash}>
              <Link
                href={`/research/${p.hash}`}
                className="flex flex-col gap-1 rounded-2xl border border-white/10 bg-white/[0.02] p-4 transition hover:border-white/20 hover:bg-white/[0.04]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">
                    <span className="text-white/40">#{p.id.toString()} · </span>
                    {p.title || <span className="italic text-white/50">(untitled)</span>}
                  </div>
                  <StatusPill status={p.status} label={p.statusLabel} />
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
                  <span>
                    Disease:{' '}
                    <span className="text-white/70">
                      {p.diseaseName || `#${p.chunkId.toString()}`}
                    </span>
                  </span>
                  <span>
                    Proposer: <span className="text-white/70">{shortAddress(p.proposer)}</span>
                  </span>
                  <span>
                    Votes:{' '}
                    <span className="text-emerald-400/80">{p.forvotes > 0n ? '✓' : '—'}</span>
                    <span className="mx-1">/</span>
                    <span className="text-rose-400/80">{p.againstvotes > 0n ? '✗' : '—'}</span>
                    <span className="ml-1 text-white/40">({p.nbvoters.toString()} voters)</span>
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ status, label }: { status: ProposalStatus; label: string }) {
  const color =
    status === ProposalStatus.Accepted
      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
      : status === ProposalStatus.Rejected
        ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
        : 'border-amber-400/30 bg-amber-400/10 text-amber-200';
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${color}`}
    >
      {label}
    </span>
  );
}
