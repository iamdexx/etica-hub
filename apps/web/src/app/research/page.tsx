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

const TERMINAL_STATS = [
  ['Source', 'Etica core'],
  ['Content', 'IPFS rendered'],
  ['Tipping', 'ETI enabled'],
  ['Refresh', '60s cache'],
];

const RESEARCH_BARS = [38, 58, 44, 82, 64, 104, 74, 118, 96, 86, 126, 108];

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
  const pendingCount = proposals.filter((p) => p.status === ProposalStatus.Pending).length;
  const acceptedCount = proposals.filter((p) => p.status === ProposalStatus.Accepted).length;
  const rejectedCount = proposals.filter((p) => p.status === ProposalStatus.Rejected).length;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-sky-400/20 bg-[#061018] shadow-2xl shadow-sky-950/20">
        <div className="grid gap-6 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.2),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.82fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-sky-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
              Research Proposal Terminal · chain {chainId}
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Research Hub with proposal intelligence.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Every research proposal submitted to the Etica core contract, pulled live from chain {chainId}, rendered from IPFS, searchable by disease, proposer, status, and title.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer" className="rounded-md border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-sky-100 hover:bg-sky-400/15">Open explorer</Link>
              <Link href="/explorer/tokens" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">ETI token</Link>
              <Link href="/whitepaper" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Whitepaper</Link>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="uppercase tracking-wider text-white/40">Proposal activity</span>
              <span className="text-sky-200">{proposals.length} indexed</span>
            </div>
            <div className="mt-4 flex h-36 items-end gap-2 rounded-xl border border-white/10 bg-black/30 p-3">
              {RESEARCH_BARS.map((height, index) => (
                <div key={index} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <span className="w-full rounded-t bg-sky-300/70" style={{ height }} />
                  <span className="h-1 w-full rounded bg-white/15" />
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TERMINAL_STATS.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
                  <div className="mt-1 text-xs font-medium text-white/80">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.72fr_1fr] lg:items-start">
        <aside className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <MetricCard label="Pending" value={String(pendingCount)} tone="amber" />
            <MetricCard label="Accepted" value={String(acceptedCount)} tone="emerald" />
            <MetricCard label="Rejected" value={String(rejectedCount)} tone="rose" />
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
            <div className="text-xs uppercase tracking-wider text-white/40">Research controls</div>
            <form className="mt-4 space-y-4" role="search">
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
                          ? 'border-sky-300/40 bg-sky-300/10 text-sky-100'
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
                placeholder="Search title, disease, or proposer..."
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-sky-300/50 focus:outline-none"
              />
              {statusFilter !== 'all' && (
                <input type="hidden" name="status" value={String(statusFilter)} />
              )}
              <button className="w-full rounded-lg bg-brand-accent px-3 py-2 text-sm font-medium text-brand-ink hover:opacity-90">
                Search proposals
              </button>
            </form>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-xs leading-5 text-white/50">
            <div className="font-medium text-white/70">Proposal workflow</div>
            <p className="mt-1">Open proposals to inspect IPFS content, voter status, proposer identity, and tipping paths without leaving the Research Hub.</p>
          </div>
        </aside>

        <div className="rounded-2xl border border-sky-400/20 bg-white/[0.03] p-3 shadow-xl shadow-sky-950/20">
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
                    className="flex flex-col gap-1 rounded-2xl border border-white/10 bg-black/25 p-4 transition hover:border-sky-300/30 hover:bg-sky-300/[0.04]"
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
      </section>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: 'amber' | 'emerald' | 'rose' }) {
  const color = tone === 'amber' ? 'text-amber-200' : tone === 'emerald' ? 'text-emerald-200' : 'text-rose-200';
  return (
    <div className="rounded-xl border border-white/10 bg-[#07120f] p-4">
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className={`mt-2 font-mono text-xl font-semibold ${color}`}>{value}</div>
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
