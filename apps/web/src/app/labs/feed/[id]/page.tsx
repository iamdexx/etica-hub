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
import { useParams, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAccount, useWalletClient } from 'wagmi';

import { signSubmit } from '@/lib/labs/client-sig';
import type {
  LabsCandidateResult,
  LabsJob,
  LabsJobEvent,
  LabsJobStatus,
} from '@/lib/labs/job';
import { buildRibbonSvg } from '@/lib/labs/pdb-render';
import {
  buildPlainSummary,
  confidenceTier,
  looksLikeNarration,
  scoreLabel,
} from '@/lib/labs/plain-summary';
import { MintResButton } from '@/components/labs/MintResButton';

const GLOSSARY = {
  pLDDT:
    'pLDDT — the fold model’s confidence score (0–100) for how reliable the predicted 3D shape is. Higher is better.',
  ESMFold:
    'ESMFold — an AI model that predicts a protein’s 3D shape directly from its amino-acid sequence.',
  residues: 'Residues — the individual amino-acid building blocks along the protein chain.',
} as const;

/** Inline glossary term: dotted-underline label with a hover/tap definition. */
function Term({ def, children }: { def: string; children: ReactNode }): JSX.Element {
  return (
    <abbr
      title={def}
      className="cursor-help border-b border-dotted border-white/35 no-underline"
    >
      {children}
    </abbr>
  );
}

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

/**
 * Renders a candidate's real ESMFold Cα backbone as a 3D cartoon ribbon
 * (rainbow N→C) — the exact image that mints as the NFT. Pure SVG (no WebGL),
 * so every candidate paints reliably regardless of grid position.
 */
function FoldRibbon({ svg }: { svg: string }): JSX.Element {
  return (
    <div
      className="block h-full w-full"
      role="img"
      aria-label="ESMFold Cα backbone rendered as a 3D cartoon ribbon, coloured N→C"
      // SVG is generated server-side-identically by buildRibbonSvg (no user input).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * On-demand interactive 3D viewer rendered in a modal. Only ever one viewer is
 * mounted at a time (no grid), which avoids 3Dmol's shared-renderer viewport
 * bug that left side-by-side viewers blank.
 */
function Structure3DModal({
  pdb,
  title,
  onClose,
}: {
  pdb: string;
  title: string;
  onClose: () => void;
}): JSX.Element {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerInstanceRef = useRef<Viewer3D | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load3Dmol()
      .then(() => {
        if (cancelled || !viewerRef.current) return;
        const w = window as Win3Dmol;
        const viewer = w.$3Dmol?.createViewer(viewerRef.current, {
          backgroundColor: '#020806',
        });
        if (!viewer) {
          setError('3D viewer failed to initialize.');
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
          setError(err instanceof Error ? err.message : 'Viewer failed to load.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pdb]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-xl border border-white/15 bg-[#020806] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Interactive 3D structure — ${title}`}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <span className="text-xs text-white/70">{title} · drag to rotate</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            close
          </button>
        </div>
        <div
          ref={viewerRef}
          className="relative h-[60vh] w-full"
          aria-label="3D protein structure"
        />
        {error && (
          <p className="border-t border-white/5 p-2 text-[11px] text-rose-300">{error}</p>
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  jobId,
  candidate,
  pdb,
  submitterWallet,
  onRefoldQueued,
}: {
  jobId: string;
  candidate: LabsCandidateResult;
  pdb: string | undefined;
  submitterWallet: `0x${string}` | undefined;
  onRefoldQueued: () => void;
}): JSX.Element {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [archivedPdb, setArchivedPdb] = useState<string | null>(null);
  const [archiveTried, setArchiveTried] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refolding, setRefolding] = useState(false);
  const [refoldStatus, setRefoldStatus] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchPrompt, setBranchPrompt] = useState('');
  const [branching, setBranching] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [show3D, setShow3D] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  // When the job result doesn't carry this candidate's PDB inline (only one is
  // kept inline), fetch the real structure we archived per-sequence so every
  // folded candidate still renders its actual fold — not just candidate #1.
  useEffect(() => {
    if (pdb || !candidate.folded || !candidate.sequence) return;
    let cancelled = false;
    fetch(`/api/labs/structure?seq=${encodeURIComponent(candidate.sequence)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ pdb?: string | null }>) : null))
      .then((d) => {
        if (cancelled) return;
        setArchivedPdb(d?.pdb ?? null);
        setArchiveTried(true);
      })
      .catch(() => {
        if (!cancelled) setArchiveTried(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pdb, candidate.folded, candidate.sequence]);

  const effectivePdb = pdb ?? archivedPdb ?? undefined;

  // Render the real Cα backbone as a 3D cartoon ribbon once per structure —
  // the same image that mints as the NFT (see FoldRibbon). Pure SVG, so every
  // candidate's fold paints reliably regardless of grid position.
  const ribbon = useMemo(
    () => (effectivePdb ? buildRibbonSvg(effectivePdb, { width: 440, height: 300, pad: 24 }) : null),
    [effectivePdb],
  );

  const tier = ribbon ? confidenceTier(ribbon.meanPlddt) : null;

  // Lead with a jargon-free sentence built from the facts we trust (length +
  // fold confidence). Only fall back to a stored analysis if it isn't the old
  // leaked model reasoning ("The user wants me to…").
  const plainSummary = ribbon
    ? buildPlainSummary({
        residues: ribbon.residues,
        meanPlddt: ribbon.meanPlddt,
        minPlddt: ribbon.minPlddt,
        maxPlddt: ribbon.maxPlddt,
      })
    : candidate.analysis && !looksLikeNarration(candidate.analysis)
      ? candidate.analysis
      : null;

  const hasCleanNotes = !!candidate.analysis && !looksLikeNarration(candidate.analysis);

  const requestRefold = useCallback(async () => {
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
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setRefoldStatus(body.error ?? `Re-fold request failed (${res.status}).`);
      }
    } catch (err) {
      setRefoldStatus(
        err instanceof Error ? err.message : 'Re-fold request failed.',
      );
    } finally {
      setRefolding(false);
    }
  }, [jobId, candidate.index, onRefoldQueued]);

  async function handleCopySequence(): Promise<void> {
    try {
      await navigator.clipboard.writeText(candidate.sequence);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function handleBranch(): Promise<void> {
    setBranchError(null);
    const prompt = branchPrompt.trim();
    if (!prompt) {
      setBranchError('Describe what to explore on this lead.');
      return;
    }
    if (!isConnected || !address || !walletClient) {
      setBranchError('Connect your wallet to start a branch.');
      return;
    }
    setBranching(true);
    try {
      const signedPayload = `branch:${jobId}#${candidate.index}|${prompt}`;
      const sig = await signSubmit({
        action: 'submit-job',
        payload: signedPayload,
        wallet: address,
        walletClient,
      });
      const res = await fetch('/api/labs/goals/branch-from-candidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parentJobId: jobId,
          candidateIndex: candidate.index,
          prompt,
          wallet: sig.wallet,
          signature: sig.signature,
          issuedAt: sig.issuedAt,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        jobId?: string;
        goalId?: string;
        error?: string;
      };
      if (!res.ok || !body.jobId) {
        setBranchError(body.error ?? `Branch failed (${res.status}).`);
        return;
      }
      router.push(`/labs/feed/${body.jobId}`);
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : 'Branch failed.');
    } finally {
      setBranching(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-0.5 text-xs text-white/80">
            candidate #{candidate.index + 1}
          </span>
          {tier && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${tier.badgeClass}`}
              title={`Fold-model confidence (mean pLDDT) ${tier.score} out of 100`}
            >
              {tier.label} confidence
            </span>
          )}
          {typeof candidate.score === 'number' && (
            <span className="rounded-full border border-white/15 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/70">
              score {candidate.score.toFixed(2)} · {scoreLabel(candidate.score)}
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

      {plainSummary && (
        <div className="mt-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            What this is
          </p>
          <p className="mt-1 text-sm text-white/85">{plainSummary}</p>
        </div>
      )}

      {effectivePdb && ribbon ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-white/10 bg-[#020806]">
          <div className="relative h-72 w-full">
            <FoldRibbon svg={ribbon.svg} />
            <button
              type="button"
              onClick={() => setShow3D(true)}
              className="absolute right-2 top-2 rounded border border-white/15 bg-black/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/75 backdrop-blur-sm transition-colors hover:border-white/35 hover:text-white"
            >
              interactive 3D
            </button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-white/5 px-3 py-2 text-[10px] text-white/45">
            <span>
              real <Term def={GLOSSARY.ESMFold}>ESMFold</Term> shape ·{' '}
              {ribbon.residues} <Term def={GLOSSARY.residues}>residues</Term> ·{' '}
              <Term def={GLOSSARY.pLDDT}>confidence</Term> {Math.round(ribbon.meanPlddt)}/100
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-white/40">N</span>
              <span
                className="inline-block h-2 w-16 rounded-sm"
                style={{
                  background:
                    'linear-gradient(90deg,#1f4ff0,#19c3c9,#3fd14d,#ffd11a,#ff3b30)',
                }}
              />
              <span className="text-white/40">C</span>
            </span>
          </div>
        </div>
      ) : effectivePdb ? (
        <p className="mt-4 text-[11px] text-white/45">
          Structure too short to visualise as a backbone trace.
        </p>
      ) : candidate.folded && !archiveTried ? (
        <p className="mt-4 text-[11px] text-white/45">Loading structure…</p>
      ) : candidate.folded ? (
        <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[11px] text-white/55">
            This candidate had its structure dropped before archiving —
            regenerate it to render the real fold (and mint it as the NFT image).
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={refolding}
              onClick={requestRefold}
              className="rounded border border-emerald-300/40 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-100 transition-colors hover:border-emerald-200/60 hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refolding ? 'queuing…' : 'regenerate structure'}
            </button>
            {refoldStatus && <span className="text-[11px] text-white/70">{refoldStatus}</span>}
          </div>
        </div>
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
              onClick={requestRefold}
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

      {(ribbon || hasCleanNotes) && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="text-[11px] uppercase tracking-wider text-white/40 transition-colors hover:text-white/75"
          >
            {showDetail ? '− Hide scientific detail' : '+ Show scientific detail'}
          </button>
          {showDetail && (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-white/5 bg-black/20 p-3 text-xs">
              {ribbon && (
                <>
                  <div>
                    <dt className="text-white/40">Length</dt>
                    <dd className="text-white/80">
                      {ribbon.residues} <Term def={GLOSSARY.residues}>residues</Term>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-white/40">
                      <Term def={GLOSSARY.pLDDT}>pLDDT</Term> confidence
                    </dt>
                    <dd className="text-white/80">
                      mean {Math.round(ribbon.meanPlddt)} · range{' '}
                      {Math.round(ribbon.minPlddt)}–{Math.round(ribbon.maxPlddt)}
                    </dd>
                  </div>
                </>
              )}
              {typeof candidate.score === 'number' && (
                <div>
                  <dt className="text-white/40">Score</dt>
                  <dd className="text-white/80">
                    {candidate.score.toFixed(2)} — {scoreLabel(candidate.score)}
                  </dd>
                </div>
              )}
              {candidate.engine && (
                <div>
                  <dt className="text-white/40">Fold engine</dt>
                  <dd className="text-white/80">{candidate.engine}</dd>
                </div>
              )}
              {hasCleanNotes && (
                <div className="col-span-2 border-t border-white/5 pt-2">
                  <dt className="text-white/40">Model notes</dt>
                  <dd className="mt-1 leading-relaxed text-white/70">{candidate.analysis}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}

      <MintResButton
        jobId={jobId}
        candidateIndex={candidate.index}
        submitter={submitterWallet}
        hasSequence={!!candidate.sequence}
      />

      <div className="mt-4 border-t border-white/5 pt-3">
        {!branchOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setBranchOpen(true);
                setBranchError(null);
                if (!branchPrompt) {
                  setBranchPrompt(
                    `Continue this lead from candidate #${candidate.index + 1}. Refine for higher affinity and lower off-target risk.`,
                  );
                }
              }}
              className="rounded border border-emerald-300/40 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-100 transition-colors hover:border-emerald-200/60 hover:bg-emerald-400/20"
            >
              branch from this RES
            </button>
            <span className="text-[11px] text-white/45">
              starts a child research chain that inherits this candidate&apos;s context
            </span>
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.04] p-3">
            <p className="text-[11px] uppercase tracking-wider text-emerald-200/80">
              branch from RES #{candidate.index + 1}
            </p>
            <textarea
              value={branchPrompt}
              onChange={(e) => setBranchPrompt(e.target.value)}
              maxLength={400}
              rows={3}
              placeholder="Describe what to explore next on this lead…"
              className="w-full resize-none rounded border border-white/10 bg-black/30 p-2 text-xs text-white/90 outline-none focus:border-emerald-300/40"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-white/45">
                {branchPrompt.length}/400 · one wallet signature required
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={branching}
                  onClick={() => {
                    setBranchOpen(false);
                    setBranchError(null);
                  }}
                  className="rounded border border-white/10 px-2.5 py-1 text-[11px] uppercase tracking-wider text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:opacity-50"
                >
                  cancel
                </button>
                <button
                  type="button"
                  disabled={branching || !branchPrompt.trim()}
                  onClick={() => {
                    void handleBranch();
                  }}
                  className="rounded border border-emerald-300/40 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-wider text-emerald-100 transition-colors hover:border-emerald-200/60 hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {branching ? 'signing…' : 'sign & start branch'}
                </button>
              </div>
            </div>
            {branchError && (
              <p className="text-[11px] text-rose-300">{branchError}</p>
            )}
            {!isConnected && (
              <p className="text-[11px] text-amber-200/80">
                Connect your wallet to start a branch.
              </p>
            )}
          </div>
        )}
      </div>

      {show3D && effectivePdb && (
        <Structure3DModal
          pdb={effectivePdb}
          title={`candidate #${candidate.index + 1}`}
          onClose={() => setShow3D(false)}
        />
      )}
    </div>
  );
}

/** Human-readable labels for the timeline — keeps the feed jargon-free. */
const EVENT_LABELS: Partial<Record<LabsJobEvent['kind'], string>> = {
  queued: 'Queued',
  started: 'Started',
  planned: 'Research plan created',
  folded: 'Structure predicted',
  structure_pending: 'Structure pending',
  analysed: 'Analysed',
  mutated: 'New variant designed',
  proteinmpnn: 'Sequence redesigned',
  docking_ready: 'Ready for docking',
  iteration_done: 'Round complete',
  completed: 'Research complete',
  error: 'Error',
  note: 'Note',
};

/**
 * Internal/maintenance events that are noise to a reader (re-fold retries,
 * rejected drafts, goal-context bookkeeping). Hidden by default; a toggle
 * reveals them for anyone who wants the full trace.
 */
const INTERNAL_EVENT_KINDS = new Set<LabsJobEvent['kind']>([
  're_fold_requested',
  're_fold_completed',
  'fold_attempt_failed',
  'proteinmpnn_fallback',
  'sequence_rejected',
  'sequence_low_quality',
  'goal_context',
  'skipped',
]);

function friendlyKind(kind: LabsJobEvent['kind']): string {
  return EVENT_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

interface CollapsedEvent {
  event: LabsJobEvent;
  count: number;
}

/** Fold consecutive identical events (same kind + message) into one row. */
function collapseEvents(events: LabsJobEvent[]): CollapsedEvent[] {
  const out: CollapsedEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last && last.event.kind === event.kind && last.event.message === event.message) {
      last.count += 1;
      last.event = event; // keep the most recent timestamp
    } else {
      out.push({ event, count: 1 });
    }
  }
  return out;
}

function EventTimeline({ events }: { events: LabsJobEvent[] }): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  if (events.length === 0) {
    return <p className="text-sm text-white/50">No events recorded yet.</p>;
  }
  const hiddenCount = events.filter((e) => INTERNAL_EVENT_KINDS.has(e.kind)).length;
  const visible = showAll ? events : events.filter((e) => !INTERNAL_EVENT_KINDS.has(e.kind));
  const rows = collapseEvents(visible);
  return (
    <>
      <ol className="space-y-2">
        {rows.map(({ event, count }, i) => (
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
                  {friendlyKind(event.kind)}
                  {count > 1 && <span className="ml-1 text-white/40">×{count}</span>}
                </span>
                <span className="text-[11px] text-white/40">{relativeTime(event.at)}</span>
              </div>
              <p className="mt-1 text-sm text-white/80">{event.message}</p>
            </div>
          </li>
        ))}
      </ol>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 text-[11px] uppercase tracking-wider text-white/40 transition-colors hover:text-white/75"
        >
          {showAll
            ? 'Hide maintenance events'
            : `Show ${hiddenCount} maintenance event${hiddenCount === 1 ? '' : 's'}`}
        </button>
      )}
    </>
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
                    submitterWallet={
                      job.submitterWallet && /^0x[a-fA-F0-9]{40}$/.test(job.submitterWallet)
                        ? (job.submitterWallet as `0x${string}`)
                        : undefined
                    }
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
