import Link from 'next/link';
import { PROPOSAL_STATUS_LABEL, ProposalStatus } from '@etica-hub/shared';
import {
  listRecentProposals,
  resolveChainId,
  shortAddress,
  type ProposalSummary,
} from '@/lib/research';
import { SourceBadge, TelemetrySection } from '@/components/telemetry/TelemetryCards';

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
  searchParams?: SearchParams;
}) {
  const params = searchParams ?? {};
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

  const telemetry = [
    {
      label: 'Indexed proposals',
      value: String(proposals.length),
      detail: 'Live governance feed',
      tone: 'sky' as const,
    },
    {
      label: 'Pending',
      value: String(pendingCount),
      detail: 'Awaiting governance resolution',
    },
    {
      label: 'Accepted',
      value: String(acceptedCount),
      detail: 'Approved proposals',
    },
    {
      label: 'Rejected',
      value: String(rejectedCount),
      detail: 'Rejected proposals',
    },
  ];

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-sky-400/20 bg-[#061018] shadow-2xl shadow-sky-950/20">
        <div className="grid gap-5 border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-5 lg:grid-cols-[1fr_0.9fr] lg:p-6">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-sky-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
              Research Proposal Terminal · chain {chainId}
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">Research Hub with proposal intelligence.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
                Live governance proposals rendered from Etica core + IPFS with proposal status, proposer identity, disease context, and search controls integrated into one research workflow.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href="/explorer" className="rounded-md border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-sky-100 hover:bg-sky-400/15">Open explorer</Link>
              <Link href="/explorer/tokens" className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-white/75 hover:bg-white/10">ETI token</Link>
              <Link href="/whitepaper" className="rounded-md bg-brand-accent px-3 py-2 font-medium text-brand-ink hover:opacity-90">Whitepaper</Link>
            </div>
          </div>

          <TelemetrySection
            title="Research telemetry"
            badge={<SourceBadge tone="sky">live governance feed</SourceBadge>}
            metrics={telemetry}
            description="Proposal counts and statuses are loaded from the live governance feed. Decorative fake activity charts were intentionally removed in favor of direct proposal telemetry."
          />
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.72fr_1fr] lg:items-start">
        <aside className="space-y-4">
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
                      : `/research?status=${f.value}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
                  return (
                    <Link
                      key={String(f.value)}
                      href={href}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        active
                          ? 'border-sky-300/50 bg-sky-300/15 text-sky-100'
                          : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      {f.label}
                    </Link>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <input
                  name="q"
                  defaultValue={q ?? ''}
                  placeholder="Search title, proposer, disease..."
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-sky-300/50"
                />
                {statusFilter !== 'all' ? <input type="hidden" name="status" value={statusFilter} /> : null}
                <button className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-brand-ink hover:opacity-90">
                  Search
                </button>
              </div>
            </form>
          </div>
        </aside>

        <div className="space-y-4">
          {error ? (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
              Live feed unavailable: {error}
            </div>
          ) : null}
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-[#07120f] p-5 text-sm text-white/55">
              No proposals match the current filters.
            </div>
          ) : (
            filtered.map((p) => <ProposalCard key={`${p.id}-${p.chainId}`} proposal={p} />)
          )}
        </div>
      </section>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalSummary }) {
  const label = PROPOSAL_STATUS_LABEL[proposal.status] ?? `Status ${proposal.status}`;
  return (
    <article className="rounded-2xl border border-white/10 bg-[#07120f] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/35">
            Proposal #{proposal.id.toString()} · chain {proposal.chainId}
          </div>
          <h2 className="mt-2 text-xl font-semibold text-white">{proposal.title}</h2>
          <p className="mt-2 text-sm leading-6 text-white/55">{proposal.description}</p>
        </div>
        <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-3 py-1 text-xs text-sky-100">
          {label}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm md:grid-cols-3">
        <KV label="Proposer" value={shortAddress(proposal.proposer)} />
        <KV label="Disease" value={proposal.diseaseName ?? 'Unspecified'} />
        <KV label="Vote window" value={`${proposal.startDate ?? '—'} → ${proposal.endDate ?? '—'}`} />
      </dl>
    </article>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <dt className="text-xs uppercase tracking-wider text-white/35">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-white/80">{value}</dd>
    </div>
  );
}
