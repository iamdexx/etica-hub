/**
 * Per-job detail view for the Labs Autopilot feed.
 *
 * Polls /api/labs/queue/[id] every 5s while the job is not terminal,
 * and once on terminal status. Renders the prompt, event timeline,
 * plan snapshot, and each candidate's sequence + analysis + 3D
 * structure (rendered via 3Dmol.js loaded lazily once).
 *
 * The page also surfaces the canonical `EticaLabs:run-<id>` permalink
 * for pasting into a ResearchToken's evidenceURI on
 * /research-markets/launch.
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  LabsCandidateResult,
  LabsJob,
  LabsJobEvent,
  LabsJobStatus,
} from '@/lib/labs/job';

const REFRESH_MS = 5_000;

type JobResponse = {
  job?: LabsJob;
  error?: string;
};

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

let dmolPromise: Promise<void> | null = null;

function load3Dmol(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const w = window as Win3Dmol;
  if (w.$3Dmol) return Promise.resolve();
  if (dmolPromise) return dmolPromise;
  dmolPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://3Dmol.org/build/3Dmol-min.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      dmolPromise = null;
      reject(new Error('Failed to load 3Dmol.js'));
    };
    document.body.appendChild(script);
  });
  return dmolPromise;
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function statusClasses(status: LabsJobStatus): string {
  switch (status) {
    case 'pending':
      return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
    case 'running':
      return 'border-sky-400/30 bg-sky-400/10 text-sky-200';
    case 'done':
      return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
    case 'error':
      return 'border-rose-400/30 bg-rose-400/10 text-rose-200';
    default:
      return 'border-white/15 bg-white/5 text-white/70';
  }
}

function statusLabel(status: LabsJobStatus): string {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'errored';
    default:
      return status;
  }
}

function CandidateCard({
  jobId,
  candidate,
  pdb,
  onRefoldQueued,
}: {
  jobId: string;
  candidate: LabsCandidateResult;
  pdb: string | undefined;
  onRefoldQueued: () => void;
}): JSX.Element {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerInstanceRef = useRef<Viewer3D | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refolding, setRefolding] = useState(false);
  const [refoldStatus, setRefoldStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!pdb || !viewerRef.current) return;
    let cancelled = false;

    load3Dmol()
      .then(() => {
        if (cancelled || !viewerRef.current) return;
        const w = window as Win3Dmol;
        const viewer = w.$3Dmol?.createViewer(viewerRef.current, {
          backgroundColor: '#020806',
        });
        if (!viewer) {
          setViewerError('3Dmol viewer failed to initialize.');
          return;
        }
        viewer.addModel(pdb, 'pdb');
        viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
        viewer.zoomTo();
        viewer.render();
        viewer.spin(true);
        viewerInstanceRef.current = viewer;
        requestAnimationFrame(() => viewerInstanceRef.current?.resize?.());
        setTimeout(() => viewerInstanceRef.current?.resize?.(), 120);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setViewerError(err instanceof Error ? err.message : 'Viewer failed to load.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pdb]);

  useEffect(() => {
    function onResize(): void {
      viewerInstanceRef.current?.resize?.();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  async function handleCopySequence(): Promise<void> {
    try {
      await navigator.clipboard.writeText(candidate.sequence);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-0.5 text-xs text-white/80">
            candidate #{candidate.index + 1}
          </span>
          {candidate.engine && (
            <span className="text-[11px] text-white/45">via {candidate.engine}</span>
          )}
          {typeof candidate.score === 'number' && (
            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-200">
              score {candidate.score.toFixed(2)}
            </span>
          )}
        </div>
        {candidate.structurePending && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200">
            structure pending
          </span>
        )}
        {!candidate.folded && !candidate.structurePending && candidate.error && (
          <span className="text-[11px] text-rose-300">fold failed</span>
        )}
      </div>

      <p className="mt-3 text-sm text-white/80">{candidate.rationale}</p>

      <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3">
        <div className="flex items-center justify-between text-[11px] text-white/55">
          <span>sequence ({candidate.sequence.length} aa)</span>
          <button
            type="button"
            onClick={handleCopySequence}
            className="rounded border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
        <p className="mt-2 break-all font-mono text-[12px] text-white/85">
          {candidate.sequence}
        </p>
      </div>

      {candidate.analysis && (
        <div className="mt-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-white/70">
          <p className="text-[10px] uppercase tracking-wider text-white/40">analysis</p>
          <p className="mt-1 text-sm text-white/80">{candidate.analysis}</p>
        </div>
      )}

      {pdb ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-white/10 bg-[#020806]">
          <div
            ref={viewerRef}
            className="relative h-72 w-full"
            aria-label="3D protein structure"
          />
          {viewerError && (
            <p className="border-t border-white/5 p-2 text-[11px] text-rose-300">
              {viewerError}
            </p>
          )}
        </div>
      ) : candidate.folded ? (
        <p className="mt-4 text-[11px] text-white/45">
          Structure was generated but not retained in the feed snapshot.
        </p>
      ) : candidate.structurePending ? (
        <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] p-3">
          <p className="text-[11px] text-amber-200/90">
            Structure pending — the fold engines were unavailable, so this
            research was published with a sequence-only score. A retry runs
            automatically every few minutes, or you can request one now.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={refolding}
              onClick={async () => {
                setRefolding(true);
                setRefoldStatus(null);
                try {
                  const res = await fetch(
                    `/api/labs/fold/${encodeURIComponent(jobId)}/re-fold`,
                    {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ candidateIndex: candidate.index }),
                    },
                  );
                  if (res.status === 202) {
                    setRefoldStatus('Re-fold queued. New attempt within ~5 min.');
                    onRefoldQueued();
                  } else {
                    const body = (await res.json().catch(() => ({}))) as {
                      error?: string;
                    };
                    setRefoldStatus(
                      body.error ?? `Re-fold request failed (${res.status}).`,
                    );
                  }
                } catch (err) {
                  setRefoldStatus(
                    err instanceof Error ? err.message : 'Re-fold request failed.',
                  );
                } finally {
                  setRefolding(false);
                }
              }}
              className="rounded border border-amber-300/40 bg-amber-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-amber-100 transition-colors hover:border-amber-200/60 hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refolding ? 'queuing…' : 're-fold this RES'}
            </button>
            {refoldStatus && <span className="text-[11px] text-white/70">{refoldStatus}</span>}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-[11px] text-rose-300/85">
          {candidate.error ? `Fold failed: ${candidate.error}` : 'Not folded yet.'}
        </p>
      )}
    </div>
  );
}

function EventTimeline({ events }: { events: LabsJobEvent[] }): JSX.Element {
  if (events.length === 0) {
    return <p className="text-sm text-white/50">No events recorded yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {events.map((event, i) => (
        <li
          key={`${event.at}-${i}`}
          className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-sm"
        >
          <div className="mt-0.5 flex-shrink-0">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/60" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-white/55">
                {event.kind}
              </span>
              <span className="text-[11px] text-white/40">{relativeTime(event.at)}</span>
            </div>
            <p className="mt-1 text-sm text-white/80">{event.message}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function LabsFeedDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [job, setJob] = useState<LabsJob | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permalinkCopied, setPermalinkCopied] = useState(false);

  const tick = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/labs/queue/${id}`, { cache: 'no-store' });
      if (res.status === 404) {
        setError('Job not found.');
        setLoaded(true);
        return;
      }
      if (!res.ok) {
        throw new Error(`Feed unavailable (${res.status})`);
      }
      const data = (await res.json()) as JobResponse;
      if (data.job) {
        setJob(data.job);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feed unavailable');
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    tick();
    const interval = setInterval(() => {
      if (!job || job.status === 'pending' || job.status === 'running') {
        tick();
      }
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [tick, job]);

  async function handleCopyPermalink(): Promise<void> {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(`EticaLabs:${id}`);
      setPermalinkCopied(true);
      setTimeout(() => setPermalinkCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link
          href="/labs/feed"
          className="text-sm text-white/55 transition-colors hover:text-white"
        >
          ← Back to feed
        </Link>
      </div>

      {!loaded && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-8 text-center text-sm text-white/60">
          Loading run…
        </div>
      )}

      {loaded && error && !job && (
        <div className="rounded-xl border border-rose-400/30 bg-rose-400/5 p-6 text-sm text-rose-200">
          {error}
        </div>
      )}

      {job && (
        <>
          <header className="mb-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${statusClasses(job.status)}`}
                  >
                    {statusLabel(job.status)}
                  </span>
                  <span className="text-[11px] text-white/45">
                    iteration {job.iterations}/{job.maxIterations}
                  </span>
                  <span className="text-[11px] text-white/45">
                    · updated {relativeTime(job.updatedAt)}
                  </span>
                </div>
                <h1 className="mt-3 text-xl font-semibold tracking-tight text-white sm:text-2xl">
                  {job.prompt}
                </h1>
              </div>

              <button
                type="button"
                onClick={handleCopyPermalink}
                className="rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 transition-colors hover:border-white/30 hover:bg-white/10 hover:text-white"
                title="Permalink suitable for pasting into a ResearchToken evidenceURI"
              >
                {permalinkCopied ? 'copied' : `EticaLabs:${id?.slice(0, 8)}…`}
              </button>
            </div>
          </header>

          {job.result?.plan && (
            <section className="mb-8 rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
                Plan
              </h2>
              <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-white/45">
                    Hypothesis
                  </dt>
                  <dd className="mt-1 text-sm text-white/85">{job.result.plan.hypothesis}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-white/45">
                    Approach
                  </dt>
                  <dd className="mt-1 text-sm text-white/85">{job.result.plan.approach}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-white/45">
                    Success criteria
                  </dt>
                  <dd className="mt-1 text-sm text-white/85">
                    {job.result.plan.successCriteria}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-white/45">
                    Risks
                  </dt>
                  <dd className="mt-1 text-sm text-white/85">{job.result.plan.risks}</dd>
                </div>
              </dl>

              {job.result.plan.references.length > 0 && (
                <div className="mt-4 border-t border-white/5 pt-3">
                  <p className="text-[11px] uppercase tracking-wider text-white/45">
                    References
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {job.result.plan.references.map((ref) => (
                      <li key={`${ref.source}-${ref.id}`}>
                        <a
                          href={ref.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-accent hover:underline"
                        >
                          {ref.title}
                        </a>
                        <span className="ml-2 text-[11px] text-white/45">{ref.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {job.result?.candidates && job.result.candidates.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/55">
                Candidates
              </h2>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {job.result.candidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.index}
                    jobId={job.id}
                    candidate={candidate}
                    pdb={job.result?.pdbBySequenceIndex?.[candidate.index]}
                    onRefoldQueued={() => void tick()}
                  />
                ))}
              </div>
              {job.result.summary && (
                <p className="mt-4 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-sm text-white/75">
                  <span className="text-[10px] uppercase tracking-wider text-white/40">
                    Summary
                  </span>
                  <br />
                  {job.result.summary}
                </p>
              )}
            </section>
          )}

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/55">
              Timeline
            </h2>
            <EventTimeline events={job.events} />
          </section>
        </>
      )}
    </div>
  );
}
