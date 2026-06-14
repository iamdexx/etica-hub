/**
 * /labs/archive — the research encyclopedia.
 *
 * Browse the permanent archive of completed discoveries, filterable by
 * free-text keyword, disease/condition, molecular target, and the
 * academic source that fed each record (PubMed, PDB, UniProt, ChEMBL,
 * STRING, KEGG, AlphaFold). Facets are computed server-side from the
 * filtered result set so the chips always reflect what's available.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { BranchFromButton } from '@/components/labs/BranchFromButton';

interface ArchiveCandidate {
  index: number;
  sequence: string;
  rationale: string;
  score?: number;
  folded: boolean;
}

interface ArchiveEntry {
  id: string;
  jobId: string;
  goalId?: string;
  goalTitle?: string;
  disease?: string;
  prompt: string;
  completedAt: number;
  hypothesis: string;
  approach: string;
  bestCandidate: ArchiveCandidate;
  references: string[];
  minted: boolean;
}

interface Facet {
  name: string;
  count: number;
}

interface ArchiveResponse {
  results: ArchiveEntry[];
  total: number;
  facets: {
    diseases: Facet[];
    sources: Facet[];
    topScores: Array<{ id: string; score: number; disease?: string }>;
  };
}

const SOURCE_LABELS: Record<string, string> = {
  pubmed: 'PubMed',
  pdb: 'PDB',
  uniprot: 'UniProt',
  chembl: 'ChEMBL',
  string: 'STRING',
  kegg: 'KEGG',
  alphafold: 'AlphaFold',
};

function sourceLabel(name: string): string {
  return SOURCE_LABELS[name] ?? name.toUpperCase();
}

function relativeTime(ms: number): string {
  if (!ms) return '—';
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function entrySources(refs: string[]): string[] {
  const out = new Set<string>();
  for (const ref of refs ?? []) {
    const colon = ref.indexOf(':');
    if (colon <= 0) continue;
    const src = ref.slice(0, colon).trim().toLowerCase();
    if (/^[a-z]+$/.test(src)) out.add(src);
  }
  return Array.from(out);
}

function scoreTone(score: number | undefined): string {
  if (score === undefined) return 'border-white/15 bg-white/[0.04] text-white/70';
  if (score >= 0.8) return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
  if (score >= 0.6) return 'border-sky-400/30 bg-sky-400/10 text-sky-200';
  return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
}

export default function LabsArchivePage(): JSX.Element {
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState('');
  const [target, setTarget] = useState('');
  const [disease, setDisease] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [mintedOnly, setMintedOnly] = useState(false);
  const [sort, setSort] = useState<'date' | 'relevance' | 'score'>('date');

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (target.trim()) p.set('target', target.trim());
    if (disease) p.set('disease', disease);
    if (source) p.set('source', source);
    if (mintedOnly) p.set('minted', 'true');
    p.set('sort', sort);
    p.set('limit', '60');
    return p.toString();
  }, [q, target, disease, source, mintedOnly, sort]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/labs/archive?${queryString}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Archive unavailable (${res.status})`);
      const json = (await res.json()) as ArchiveResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive unavailable');
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  // Debounce text inputs; fire immediately on facet/sort/toggle changes.
  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const diseases = data?.facets.diseases ?? [];
  const sources = data?.facets.sources ?? [];
  const results = data?.results ?? [];
  const hasFilters = Boolean(q || target || disease || source || mintedOnly);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Research archive
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-white/65">
            Every completed discovery, permanently recorded. Filter by disease,
            molecular target, keyword, or the academic source that grounded it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/labs/market"
            className="rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
          >
            Marketplace
          </Link>
          <Link
            href="/labs"
            className="rounded-full border border-white/10 bg-transparent px-4 py-2 text-sm font-medium text-white/65 transition-colors hover:border-white/20 hover:text-white"
          >
            Back to Labs
          </Link>
        </div>
      </header>

      {/* ── Filter bar ── */}
      <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-white/45">
              Keyword
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="peptide, kinase, inhibitor…"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-emerald-400/50 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-white/45">
              Target
            </span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="PD-L1, TNF-α, EGFR…"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-emerald-400/50 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-white/45">
              Sort
            </span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as 'date' | 'relevance' | 'score')}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:border-emerald-400/50 focus:outline-none"
            >
              <option value="date">Newest</option>
              <option value="score">Fold score</option>
              <option value="relevance">Relevance</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2">
            <input
              type="checkbox"
              checked={mintedOnly}
              onChange={(e) => setMintedOnly(e.target.checked)}
              className="h-4 w-4 rounded border-white/20 bg-black/30 accent-emerald-400"
            />
            <span className="text-sm text-white/70">Minted only</span>
          </label>
        </div>

        {/* Academic source facets */}
        {sources.length > 0 && (
          <div className="mt-4">
            <span className="mb-2 block text-[11px] uppercase tracking-wider text-white/45">
              Academic source
            </span>
            <div className="flex flex-wrap gap-2">
              {sources.map((s) => {
                const active = source === s.name;
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => setSource(active ? null : s.name)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      active
                        ? 'border-sky-400/60 bg-sky-400/15 text-sky-100'
                        : 'border-white/10 bg-white/[0.03] text-white/60 hover:border-white/25 hover:text-white/90'
                    }`}
                  >
                    {sourceLabel(s.name)} <span className="text-white/40">{s.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Disease facets */}
        {diseases.length > 0 && (
          <div className="mt-4">
            <span className="mb-2 block text-[11px] uppercase tracking-wider text-white/45">
              Disease / condition
            </span>
            <div className="flex flex-wrap gap-2">
              {diseases.map((d) => {
                const active = disease === d.name;
                return (
                  <button
                    key={d.name}
                    type="button"
                    onClick={() => setDisease(active ? null : d.name)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      active
                        ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-100'
                        : 'border-white/10 bg-white/[0.03] text-white/60 hover:border-white/25 hover:text-white/90'
                    }`}
                  >
                    {d.name} <span className="text-white/40">{d.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setQ('');
              setTarget('');
              setDisease(null);
              setSource(null);
              setMintedOnly(false);
            }}
            className="mt-4 text-xs text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
          >
            Clear all filters
          </button>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="mb-4 text-sm text-white/45">
        {loading ? 'Searching…' : `${data?.total ?? 0} discoveries`}
      </div>

      {!loading && results.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-12 text-center">
          <p className="text-base font-medium text-white">No matching discoveries.</p>
          <p className="mt-2 text-sm text-white/60">Try widening or clearing your filters.</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((e) => {
          const srcs = entrySources(e.references);
          return (
            <div
              key={e.id}
              className="flex flex-col rounded-xl border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/20"
            >
              <div className="flex items-start justify-between gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${scoreTone(e.bestCandidate.score)}`}>
                  {e.bestCandidate.score === undefined
                    ? 'unscored'
                    : `score ${e.bestCandidate.score.toFixed(2)}`}
                </span>
                {e.minted ? (
                  <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-200">
                    minted
                  </span>
                ) : (
                  <span className="text-[10px] text-white/35">{relativeTime(e.completedAt)}</span>
                )}
              </div>

              <Link href={`/labs/feed/${e.jobId}`} className="mt-2 block">
                <h3 className="line-clamp-2 text-sm font-medium text-white/90 hover:text-emerald-200">
                  {e.goalTitle || e.prompt || `Research ${e.jobId}`}
                </h3>
              </Link>

              {e.disease && (
                <span className="mt-1 inline-block w-fit rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
                  {e.disease}
                </span>
              )}

              {e.bestCandidate.rationale && (
                <p className="mt-2 line-clamp-3 text-xs text-white/55">
                  {e.bestCandidate.rationale}
                </p>
              )}

              <div className="mt-2 text-[11px] text-white/40">
                {e.bestCandidate.sequence?.length ?? 0} aa
              </div>

              {srcs.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {srcs.map((s) => (
                    <span
                      key={s}
                      className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-white/50"
                    >
                      {sourceLabel(s)}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-auto pt-3">
                <BranchFromButton parentJobId={e.jobId} candidateIndex={e.bestCandidate.index} compact />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
