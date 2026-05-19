'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  LabsCandidateResult,
  LabsJob,
  LabsJobEvent,
  LabsJobStatus,
} from '@/lib/labs/job';

/* ------------------------------------------------------------------ */
/*  3Dmol typings (kept local to avoid an external .d.ts)              */
/* ------------------------------------------------------------------ */

type Viewer3D = {
  addModel: (data: string, format: string) => void;
  setStyle: (selector: Record<string, unknown>, style: Record<string, unknown>) => void;
  zoomTo: () => void;
  render: () => void;
  spin: (enabled: boolean) => void;
  resize?: () => void;
};

type Win3Dmol = typeof window & {
  $3Dmol?: {
    createViewer: (el: HTMLElement, opts?: Record<string, unknown>) => Viewer3D;
  };
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 5000;

function isTerminal(status: LabsJobStatus): boolean {
  return status === 'done' || status === 'error';
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function StatusBadge({ status }: { status: LabsJobStatus }) {
  const styles: Record<LabsJobStatus, string> = {
    pending: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    running: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
    done: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    error: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${styles[status]}`}
    >
      {status === 'running' && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Candidate viewer                                                   */
/* ------------------------------------------------------------------ */

function CandidateViewer({ pdb, candidateId }: { pdb: string; candidateId: string }) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<Viewer3D | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (!viewerRef.current) return;
      const win = window as Win3Dmol;

      if (!win.$3Dmol) {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector<HTMLScriptElement>('script[data-3dmol="1"]');
          if (existing) {
            if ((window as Win3Dmol).$3Dmol) {
              resolve();
            } else {
              existing.addEventListener('load', () => resolve());
              existing.addEventListener('error', () => reject(new Error('Failed to load 3Dmol.js')));
            }
            return;
          }
          const script = document.createElement('script');
          script.src = 'https://3Dmol.org/build/3Dmol-min.js';
          script.async = true;
          script.dataset.threedmol = '1';
          script.setAttribute('data-3dmol', '1');
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Failed to load 3Dmol.js'));
          document.body.appendChild(script);
        }).catch(() => undefined);
      }

      if (cancelled || !viewerRef.current) return;

      viewerRef.current.innerHTML = '';
      const viewer = (window as Win3Dmol).$3Dmol?.createViewer(viewerRef.current, {
        backgroundColor: '#020806',
      });
      if (!viewer) return;
      viewer.addModel(pdb, 'pdb');
      viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
      viewer.zoomTo();
      viewer.render();
      viewer.spin(true);
      instanceRef.current = viewer;
      requestAnimationFrame(() => viewer.resize?.());
      setTimeout(() => viewer.resize?.(), 120);
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [pdb]);

  useEffect(() => {
    function onResize(): void {
      instanceRef.current?.resize?.();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handleExport(): void {
    const blob = new Blob([pdb], { type: 'chemical/x-pdb' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `etica-labs-${candidateId}.pdb`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-2">
      <div
        ref={viewerRef}
        className="relative h-[320px] w-full min-w-0 overflow-hidden rounded-2xl border border-emerald-400/15 bg-[#020806]"
      />
      <button
        type="button"
        onClick={handleExport}
        className="inline-flex items-center justify-center rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/80 transition hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-emerald-100"
      >
        Download PDB
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Candidate card                                                     */
/* ------------------------------------------------------------------ */

function CandidateCard({
  candidate,
  pdb,
  jobId,
}: {
  candidate: LabsCandidateResult;
  pdb: string | undefined;
  jobId: string;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-[#050b09] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-emerald-200">
            Candidate {candidate.index + 1}
          </span>
          {candidate.engine && (
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
              {candidate.engine}
            </span>
          )}
          {typeof candidate.score === 'number' && (
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-200/85">
              score {(candidate.score * 100).toFixed(0)}
            </span>
          )}
        </div>
        <div className="text-[11px] text-white/40">
          {candidate.folded ? 'folded' : candidate.error ? 'fold failed' : 'not yet folded'}
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-white/40">Sequence</div>
        <div className="break-all rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-white/80">
          {candidate.sequence}
        </div>
      </div>

      {candidate.rationale && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-white/40">Rationale</div>
          <p className="text-sm leading-relaxed text-white/75">{candidate.rationale}</p>
        </div>
      )}

      {candidate.analysis && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-emerald-200/70">
            AI structural analysis
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">
            {candidate.analysis}
          </p>
        </div>
      )}

      {candidate.error && (
        <div className="rounded-xl border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200">
          {candidate.error}
        </div>
      )}

      {pdb && (
        <CandidateViewer pdb={pdb} candidateId={`${jobId.slice(0, 8)}-${candidate.index + 1}`} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Event timeline                                                     */
/* ------------------------------------------------------------------ */

const EVENT_DOTS: Record<LabsJobEvent['kind'], string> = {
  queued: 'bg-amber-400',
  started: 'bg-sky-400',
  planned: 'bg-emerald-400',
  folded: 'bg-emerald-400',
  analysed: 'bg-emerald-400',
  mutated: 'bg-violet-400',
  iteration_done: 'bg-emerald-400',
  completed: 'bg-emerald-400',
  error: 'bg-rose-400',
  note: 'bg-white/40',
};

function Timeline({ events }: { events: LabsJobEvent[] }) {
  if (!events.length) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-sm text-white/50">
        No events yet. The worker will pick this up shortly.
      </div>
    );
  }
  return (
    <ol className="space-y-2">
      {events.map((ev, i) => (
        <li
          key={`${ev.at}-${i}`}
          className="flex gap-3 rounded-xl border border-white/10 bg-black/20 p-3"
        >
          <span
            className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${EVENT_DOTS[ev.kind] ?? 'bg-white/40'}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="font-medium uppercase tracking-wider text-white/65">{ev.kind}</span>
              <span className="text-white/35">{new Date(ev.at).toISOString().slice(11, 19)}</span>
            </div>
            <p className="mt-1 break-words text-sm text-white/80">{ev.message}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/*  Main detail view                                                   */
/* ------------------------------------------------------------------ */

export function LabsRunDetail({ initialJob }: { initialJob: LabsJob }) {
  const [job, setJob] = useState<LabsJob>(initialJob);
  const [copied, setCopied] = useState(false);
  const stopped = isTerminal(job.status);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/labs/queue/${initialJob.id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { job?: LabsJob };
      if (data.job) setJob(data.job);
    } catch {
      /* swallow polling errors */
    }
  }, [initialJob.id]);

  useEffect(() => {
    if (stopped) return;
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh, stopped]);

  const events = useMemo(() => [...job.events].reverse(), [job.events]);
  const result = job.result;
  const candidates = result?.candidates ?? [];

  function handleShare(): void {
    const url = `${window.location.origin}/labs/feed/${job.id}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 md:px-6">
      {/* Hero */}
      <section className="rounded-3xl border border-emerald-400/20 bg-[#04110d] p-6 shadow-2xl shadow-emerald-950/20">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link
              href="/labs/feed"
              className="text-xs text-white/55 transition hover:text-white"
            >
              ← Public feed
            </Link>
            <div className="flex items-center gap-2">
              <StatusBadge status={job.status} />
              <button
                type="button"
                onClick={handleShare}
                className="rounded-full border border-white/15 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white/80 transition hover:border-emerald-400/30 hover:bg-emerald-400/10"
              >
                {copied ? 'Link copied' : 'Share'}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-emerald-300/80">
              Research goal
            </div>
            <p className="break-words text-lg font-medium text-white md:text-xl">{job.prompt}</p>
          </div>

          <div className="grid gap-2 text-xs text-white/55 sm:grid-cols-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Submitted</div>
              <div className="text-white/80">{relativeTime(job.createdAt)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Updated</div>
              <div className="text-white/80">{relativeTime(job.updatedAt)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Iterations</div>
              <div className="text-white/80">
                {job.iterations} / {job.maxIterations}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Job ID</div>
              <div className="break-all font-mono text-[11px] text-white/65">{job.id}</div>
            </div>
          </div>
        </div>
      </section>

      {/* Plan */}
      {result?.plan && (
        <section className="space-y-3 rounded-3xl border border-white/10 bg-[#050b09] p-5">
          <h2 className="text-sm font-medium uppercase tracking-wider text-emerald-200/80">
            Research plan
          </h2>
          <div className="grid gap-3 text-sm text-white/80 md:grid-cols-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Hypothesis</div>
              <p className="mt-1 text-white/80">{result.plan.hypothesis}</p>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Approach</div>
              <p className="mt-1 text-white/80">{result.plan.approach}</p>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">
                Success criteria
              </div>
              <p className="mt-1 text-white/80">{result.plan.successCriteria}</p>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Risks</div>
              <p className="mt-1 text-white/80">{result.plan.risks}</p>
            </div>
          </div>

          {result.plan.references.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="text-[10px] uppercase tracking-wider text-emerald-200/70">
                Related research ({result.plan.references.length})
              </div>
              <ul className="space-y-1.5">
                {result.plan.references.map((r, i) => (
                  <li
                    key={`${r.source}-${r.id}`}
                    className="min-w-0 rounded-xl border border-white/10 bg-black/20 p-2.5"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                      <span className="font-mono text-emerald-200/90">[{i + 1}]</span>
                      <span
                        className={`rounded px-1.5 py-px text-[10px] uppercase tracking-wider ${
                          r.source === 'pubmed'
                            ? 'bg-sky-400/15 text-sky-200'
                            : 'bg-violet-400/15 text-violet-200'
                        }`}
                      >
                        {r.source === 'pubmed' ? 'PubMed' : 'PDB'}
                      </span>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 break-words text-white/85 underline-offset-2 hover:underline"
                      >
                        {r.title}
                      </a>
                    </div>
                    {r.detail && (
                      <div className="mt-1 text-[11px] leading-snug text-white/45">{r.detail}</div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Candidates */}
      {candidates.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-white/55">
            Candidates ({candidates.length})
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {candidates.map((c) => (
              <CandidateCard
                key={c.index}
                candidate={c}
                pdb={result?.pdbBySequenceIndex?.[c.index]}
                jobId={job.id}
              />
            ))}
          </div>
        </section>
      )}

      {result?.summary && (
        <section className="rounded-3xl border border-emerald-400/15 bg-emerald-400/[0.04] p-5">
          <div className="text-[10px] uppercase tracking-wider text-emerald-200/70">Summary</div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-white/85">{result.summary}</p>
        </section>
      )}

      {/* Timeline */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-white/55">
            Event timeline ({events.length})
          </h2>
          {!stopped && (
            <span className="text-[11px] text-white/40">
              Auto-refreshing every {POLL_INTERVAL_MS / 1000}s
            </span>
          )}
        </div>
        <Timeline events={events} />
      </section>
    </div>
  );
}
