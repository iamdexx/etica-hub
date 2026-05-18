'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MAX_PROMPT_CHARS = 400;
const AMINO_ACIDS = 'ACDEFGHIKLMNPQRSTVWY';

type EngineDescriptor = {
  id: string;
  label: string;
  model: string;
  description: string;
  isConfigured: boolean;
  requiredEnv: string[];
};

type FoldAttempt = {
  engine: string;
  ok: boolean;
  error?: string;
  durationMs: number;
};

type FoldResponse = {
  pdb?: string;
  sequence?: string;
  engine?: string;
  attempts?: FoldAttempt[];
  error?: string;
};

type ExplainResponse = {
  analysis?: string;
  error?: string;
};

type PlanCandidate = {
  sequence: string;
  rationale: string;
};

type ResearchPlan = {
  hypothesis: string;
  approach: string;
  successCriteria: string;
  risks: string;
  candidates: PlanCandidate[];
};

type Reference = {
  source: 'pubmed' | 'pdb';
  id: string;
  title: string;
  detail: string;
  url: string;
};

type PlanResponse = {
  plan?: ResearchPlan;
  references?: Reference[];
  error?: string;
  detail?: string;
};

/* ------------------------------------------------------------------ */
/*  3Dmol viewer (typed locally to avoid external .d.ts)               */
/* ------------------------------------------------------------------ */

type Viewer3D = {
  addModel: (data: string, format: string) => void;
  setStyle: (selector: Record<string, unknown>, style: Record<string, unknown>) => void;
  zoomTo: () => void;
  render: () => void;
  spin: (enabled: boolean) => void;
  resize?: () => void;
  clear?: () => void;
};

type Win3Dmol = typeof window & {
  $3Dmol?: {
    createViewer: (el: HTMLElement, opts?: Record<string, unknown>) => Viewer3D;
  };
};

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function LabsPage() {
  /* ── refs ── */
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerInstanceRef = useRef<Viewer3D | null>(null);

  /* ── prompt + sequence ── */
  const [prompt, setPrompt] = useState(
    'Design a stable 40 amino acid peptide beginning with MVL that improves thermal resilience.',
  );
  const [sequence, setSequence] = useState('');

  /* ── engines ── */
  const [engines, setEngines] = useState<EngineDescriptor[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<string>('auto');

  /* ── fold state ── */
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<'idle' | 'sequence' | 'folding' | 'rendered'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pdb, setPdb] = useState<string | null>(null);
  const [foldEngine, setFoldEngine] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<FoldAttempt[]>([]);

  /* ── AI analysis ── */
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  /* ── research plan ── */
  const [plan, setPlan] = useState<ResearchPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);

  /* ── mutate ── */
  const [mutateIdx, setMutateIdx] = useState<number | null>(null);
  const [mutateAA, setMutateAA] = useState('');

  /* ── share ── */
  const [copied, setCopied] = useState(false);

  const charsRemaining = useMemo(() => MAX_PROMPT_CHARS - prompt.length, [prompt.length]);

  /* ── fetch engine roster on mount ── */
  useEffect(() => {
    fetch('/api/labs/engines', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ engines: EngineDescriptor[] }>)
      .then((j) => setEngines(j.engines ?? []))
      .catch(() => {});
  }, []);

  /* ── 3Dmol render ── */
  const renderMolecule = useCallback(async (pdbText: string) => {
    if (!viewerRef.current) return;

    const win = window as Win3Dmol;

    if (!win.$3Dmol) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://3Dmol.org/build/3Dmol-min.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load 3Dmol.js'));
        document.body.appendChild(script);
      });
    }

    viewerRef.current.innerHTML = '';
    const viewer = (window as Win3Dmol).$3Dmol?.createViewer(viewerRef.current, {
      backgroundColor: '#020806',
    });
    if (!viewer) return;

    viewer.addModel(pdbText, 'pdb');
    viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
    viewer.zoomTo();
    viewer.render();
    viewer.spin(true);
    viewerInstanceRef.current = viewer;

    // 3Dmol's WebGL canvas defaults to its intrinsic size; on mobile the grid
    // hands us a final width AFTER the first paint, so the canvas can overflow
    // the parent rounded panel and bleed into adjacent UI. Force a resize on
    // the next two frames so the canvas matches the parent box.
    requestAnimationFrame(() => viewerInstanceRef.current?.resize?.());
    setTimeout(() => viewerInstanceRef.current?.resize?.(), 120);
  }, []);

  /* ── re-resize on viewport change so the canvas stays inside the panel ── */
  useEffect(() => {
    function onResize(): void {
      viewerInstanceRef.current?.resize?.();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ── Research plan ── */
  const handlePlan = useCallback(async () => {
    if (!prompt.trim()) return;
    setPlanLoading(true);
    setPlanError(null);
    setPlan(null);
    setReferences([]);
    try {
      const res = await fetch('/api/labs/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = (await res.json()) as PlanResponse;
      if (!res.ok || !data.plan) {
        setPlanError(data.error ?? `Planner returned ${res.status}.`);
        return;
      }
      setPlan(data.plan);
      if (data.references) setReferences(data.references);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to reach the planner.');
    } finally {
      setPlanLoading(false);
    }
  }, [prompt]);

  /* ── reset / close the rendered viewer ── */
  const handleResetViewer = useCallback(() => {
    if (viewerRef.current) viewerRef.current.innerHTML = '';
    viewerInstanceRef.current = null;
    setPdb(null);
    setStage('idle');
    setError(null);
    setAnalysis(null);
    setAttempts([]);
    setFoldEngine(null);
    setMutateIdx(null);
    setMutateAA('');
  }, []);

  /* ── AI explain ── */
  const handleExplain = useCallback(async () => {
    if (!sequence) return;
    setAnalysisLoading(true);
    setAnalysis(null);
    try {
      const res = await fetch('/api/labs/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequence, prompt }),
      });
      const data = (await res.json()) as ExplainResponse;
      if (data.analysis) setAnalysis(data.analysis);
      else setAnalysis(data.error ?? 'Analysis unavailable.');
    } catch {
      setAnalysis('Failed to reach the AI analysis endpoint.');
    } finally {
      setAnalysisLoading(false);
    }
  }, [sequence, prompt]);

  /* ── main generate flow ── */
  async function handleGenerate(overrideSequence?: string): Promise<void> {
    setLoading(true);
    setError(null);
    setPdb(null);
    setFoldEngine(null);
    setAttempts([]);
    setAnalysis(null);

    const seqToFold = overrideSequence ?? '';

    try {
      let finalSequence = seqToFold;

      if (!finalSequence) {
        setStage('sequence');
        setSequence('');
        const seqResponse = await fetch('/api/labs/sequence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        const seqPayload = await seqResponse.json();
        if (!seqResponse.ok) throw new Error(seqPayload.error ?? 'Failed to generate sequence.');
        finalSequence = seqPayload.sequence;
        setSequence(finalSequence);
      }

      setStage('folding');

      const foldBody: Record<string, unknown> = { sequence: finalSequence };
      if (selectedEngine !== 'auto') {
        foldBody.engine = selectedEngine;
        foldBody.exclusive = true;
      }

      const foldResponse = await fetch('/api/labs/fold', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(foldBody),
      });

      const foldPayload = (await foldResponse.json()) as FoldResponse;

      if (foldPayload.attempts) setAttempts(foldPayload.attempts);
      if (foldPayload.engine) setFoldEngine(foldPayload.engine);

      if (!foldResponse.ok) {
        throw new Error(foldPayload.error ?? 'Failed to fold sequence.');
      }

      if (foldPayload.pdb) {
        setPdb(foldPayload.pdb);
        await renderMolecule(foldPayload.pdb);
      }

      setStage('rendered');
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : typeof err === 'string' && err
            ? err
            : 'Labs request failed. See the engine trace below for details.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  /* ── mutate + re-fold ── */
  function handleMutate(): void {
    if (mutateIdx === null || !mutateAA || !sequence) return;
    const idx = mutateIdx;
    if (idx < 0 || idx >= sequence.length) return;
    const upper = mutateAA.toUpperCase();
    if (!AMINO_ACIDS.includes(upper)) return;
    const mutated = sequence.slice(0, idx) + upper + sequence.slice(idx + 1);
    setSequence(mutated);
    setMutateIdx(null);
    setMutateAA('');
    handleGenerate(mutated);
  }

  /* ── export PDB ── */
  function handleExport(): void {
    if (!pdb) return;
    const blob = new Blob([pdb], { type: 'chemical/x-pdb' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `etica-labs-${sequence.slice(0, 8)}.pdb`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── share ── */
  function handleShare(): void {
    const params = new URLSearchParams();
    if (prompt) params.set('p', prompt);
    if (sequence) params.set('s', sequence);
    if (selectedEngine !== 'auto') params.set('e', selectedEngine);
    const url = `${window.location.origin}/labs?${params.toString()}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  /* ── hydrate from URL params ── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get('p');
    const s = params.get('s');
    const e = params.get('e');
    if (p) setPrompt(p);
    if (s) setSequence(s);
    // Only honor engine param if it points to a real, non-broken engine.
    // Old shared URLs with ?e=hf-esmfold lock users to the deprovisioned
    // HuggingFace endpoint. Default to auto-cascade in that case.
    if (e && e !== 'hf-esmfold') setSelectedEngine(e);
  }, []);

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 md:px-6">
      {/* ── Hero ── */}
      <section className="rounded-3xl border border-emerald-400/20 bg-[#04110d] p-6 shadow-2xl shadow-emerald-950/20">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-emerald-300">
              Etica Labs &middot; AI Molecular Intelligence
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-white md:text-5xl">
              Design, fold, analyze &amp; share peptide structures.
            </h1>
            <p className="text-base text-white/70 md:text-lg">
              Natural-language design, multi-engine structure prediction with automatic failover,
              AI-powered structural analysis, and real-time WebGL rendering.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="LLM" value="Groq" />
            <Metric label="Folding" value={foldEngine ?? 'Multi-engine'} />
            <Metric label="Rendering" value="3Dmol.js" />
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.92fr_1.08fr]">
        {/* ── Left column: prompt + controls ── */}
        <div className="min-w-0 space-y-5 rounded-3xl border border-white/10 bg-[#050b09] p-5">
          <div>
            <div className="text-sm font-medium text-white">Prompt</div>
            <div className="mt-1 text-sm text-white/55">
              Describe the peptide or paste an amino-acid sequence.
            </div>
          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_CHARS))}
            className="min-h-[160px] w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white outline-none ring-0 transition focus:border-emerald-400/40"
            placeholder="Design a 40 amino acid peptide beginning with MVL..."
          />

          <div className="flex items-center justify-between text-xs text-white/45">
            <span>Max {MAX_PROMPT_CHARS} characters</span>
            <span>{charsRemaining} remaining</span>
          </div>

          {/* ── Research planner ── */}
          <div className="space-y-3 rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-emerald-100">Research plan</div>
                <div className="mt-0.5 text-xs text-white/55">
                  Optional. Have the AI scope a hypothesis &amp; 3 candidates before folding.
                </div>
              </div>
              <button
                type="button"
                onClick={handlePlan}
                disabled={planLoading || prompt.trim().length === 0}
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-100 transition hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {planLoading ? 'Planning\u2026' : plan ? 'Replan' : 'Create plan'}
              </button>
            </div>

            {planError && (
              <div className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                {planError}
              </div>
            )}

            {plan && (
              <div className="space-y-3 text-sm text-white/80">
                <PlanField label="Hypothesis" value={plan.hypothesis} />
                <PlanField label="Approach" value={plan.approach} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <PlanField label="Success criteria" value={plan.successCriteria} compact />
                  <PlanField label="Risks" value={plan.risks} compact />
                </div>

                {references.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-emerald-200/70">
                      {`Related research (${references.length}) — candidates cite by [N]`}
                    </div>
                    <ul className="space-y-1.5">
                      {references.map((r, i) => (
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
                            <div className="mt-1 text-[11px] leading-snug text-white/45">
                              {r.detail}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-emerald-200/70">
                    Candidates ({plan.candidates.length})
                  </div>
                  {plan.candidates.map((c, i) => (
                    <div
                      key={i}
                      className="min-w-0 rounded-xl border border-white/10 bg-black/30 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-medium text-white/80">
                          Candidate {i + 1}
                          <span className="ml-2 text-white/40">{c.sequence.length} aa</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSequence(c.sequence);
                            handleGenerate(c.sequence);
                          }}
                          disabled={loading}
                          className="inline-flex items-center gap-1 rounded-full bg-brand-accent px-3 py-1 text-[11px] font-medium text-brand-ink transition hover:opacity-90 disabled:opacity-50"
                        >
                          Fold this
                        </button>
                      </div>
                      {c.rationale && (
                        <div className="mt-1.5 text-xs leading-snug text-white/55">
                          {c.rationale}
                        </div>
                      )}
                      <div className="mt-2 break-all font-mono text-[11px] leading-relaxed text-emerald-200/80">
                        {c.sequence}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Engine selector ── */}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-white/50">
              Folding engine
            </div>
            <div className="flex flex-wrap gap-2">
              <EnginePill
                id="auto"
                label="Auto"
                description="Cascade through all configured engines"
                active={selectedEngine === 'auto'}
                configured
                onClick={() => setSelectedEngine('auto')}
              />
              {engines.map((eng) => (
                <EnginePill
                  key={eng.id}
                  id={eng.id}
                  label={eng.label}
                  description={eng.isConfigured ? eng.description : `Requires ${eng.requiredEnv.join(', ')}`}
                  active={selectedEngine === eng.id}
                  configured={eng.isConfigured}
                  onClick={() => setSelectedEngine(eng.id)}
                />
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleGenerate()}
            disabled={loading || prompt.trim().length === 0}
            className="inline-flex items-center justify-center rounded-full bg-brand-accent px-5 py-3 text-sm font-medium text-brand-ink transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Generating structure\u2026' : 'Generate molecule'}
          </button>

          {/* ── Pipeline info ── */}
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/70">
            <div className="font-medium text-white">Pipeline</div>
            <ol className="mt-3 space-y-2 text-white/60">
              <li>1. Prompt &rarr; Groq research plan (optional)</li>
              <li>2. Plan / Prompt &rarr; Groq sequence extraction</li>
              <li>3. Sequence &rarr; {selectedEngine === 'auto' ? 'Multi-engine cascade' : engines.find((e) => e.id === selectedEngine)?.label ?? selectedEngine}</li>
              <li>4. PDB &rarr; 3Dmol.js render</li>
              <li>5. Sequence &rarr; AI structural analysis</li>
            </ol>
          </div>

          {/* ── Fold attempts trace ── */}
          {attempts.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs font-medium uppercase tracking-wider text-white/50">
                Engine trace
              </div>
              <div className="mt-2 space-y-2">
                {attempts.map((a, i) => (
                  <div key={i} className="min-w-0 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={a.ok ? 'text-emerald-400' : 'text-rose-400'}>
                        {a.ok ? '\u25CF' : '\u25CB'}
                      </span>
                      <span className="truncate font-medium text-white/80">{a.engine}</span>
                      {a.durationMs > 0 && (
                        <span className="ml-auto shrink-0 text-white/40">
                          {(a.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                    {a.error && !a.ok && (
                      <div
                        className="mt-1 break-words pl-5 text-[11px] leading-snug text-white/40"
                        title={a.error}
                      >
                        {a.error.length > 160 ? `${a.error.slice(0, 160)}\u2026` : a.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right column: viewer + analysis + tools ── */}
        <div className="min-w-0 space-y-5 rounded-3xl border border-white/10 bg-[#050b09] p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-white">Molecular Viewer</div>
              <div className="mt-1 text-sm text-white/55">
                Interactive WebGL visualization rendered directly in-browser.
              </div>
            </div>
            <StatusBadge stage={stage} />
          </div>

          <div className="relative w-full min-w-0">
            <div
              ref={viewerRef}
              className="relative h-[440px] w-full min-w-0 overflow-hidden rounded-3xl border border-emerald-400/15 bg-[#020806]"
            >
              {!pdb && (
                <div className="flex h-full items-center justify-center text-center text-sm text-white/40">
                  {loading ? 'Preparing protein structure\u2026' : 'Your folded molecule will render here.'}
                </div>
              )}
            </div>
            {pdb && (
              <button
                type="button"
                onClick={handleResetViewer}
                aria-label="Close fold and reset"
                className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white/80 backdrop-blur transition hover:bg-black/80 hover:text-white"
              >
                <CloseIcon />
              </button>
            )}
          </div>

          {/* ── Action bar: Export + Share + Explain ── */}
          {stage === 'rendered' && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white transition hover:bg-white/10"
              >
                <DownloadIcon /> Export PDB
              </button>
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white transition hover:bg-white/10"
              >
                <ShareIcon /> {copied ? 'Copied!' : 'Share link'}
              </button>
              <button
                type="button"
                onClick={handleExplain}
                disabled={analysisLoading}
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-4 py-2 text-xs font-medium text-emerald-200 transition hover:bg-emerald-400/20 disabled:opacity-50"
              >
                <SparkleIcon /> {analysisLoading ? 'Analyzing\u2026' : 'AI Analysis'}
              </button>
              <button
                type="button"
                onClick={handleResetViewer}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 transition hover:bg-white/10"
              >
                <CloseIcon /> Start over
              </button>
            </div>
          )}

          {/* ── AI analysis panel ── */}
          {analysis && (
            <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/5 p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-emerald-300/70">
                AI Structural Analysis
              </div>
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-white/80">
                {analysis}
              </div>
            </div>
          )}

          {/* ── Sequence + System status ── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-wider text-white/40">Extracted sequence</div>
              <div className="mt-3 break-all font-mono text-xs text-emerald-200">
                {sequence || 'No sequence generated yet.'}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-wider text-white/40">System status</div>
              <div className="mt-3 space-y-2 text-sm text-white/70">
                <div>Groq parsing: operational</div>
                <div>
                  Engines:{' '}
                  {engines.length > 0
                    ? `${engines.filter((e) => e.isConfigured).length}/${engines.length} configured`
                    : 'loading\u2026'}
                </div>
                <div>3D renderer: active</div>
              </div>
            </div>
          </div>

          {/* ── Mutate panel ── */}
          {sequence && stage === 'rendered' && (
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="mb-3 text-xs font-medium uppercase tracking-wider text-white/50">
                Point mutation
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-white/50">Position (0-indexed)</span>
                  <input
                    type="number"
                    min={0}
                    max={sequence.length - 1}
                    value={mutateIdx ?? ''}
                    onChange={(e) => setMutateIdx(e.target.value === '' ? null : Number(e.target.value))}
                    className="block w-20 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/40"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-white/50">New residue</span>
                  <input
                    type="text"
                    maxLength={1}
                    value={mutateAA}
                    onChange={(e) => setMutateAA(e.target.value.toUpperCase())}
                    className="block w-14 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-center text-sm text-white outline-none focus:border-emerald-400/40"
                    placeholder="A"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleMutate}
                  disabled={mutateIdx === null || !mutateAA || loading}
                  className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white transition hover:bg-white/10 disabled:opacity-40"
                >
                  Mutate &amp; re-fold
                </button>
                {mutateIdx !== null && mutateIdx >= 0 && mutateIdx < sequence.length && (
                  <span className="text-xs text-white/40">
                    Current: <span className="font-mono text-emerald-300">{sequence[mutateIdx]}</span> at position {mutateIdx}
                  </span>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="space-y-2 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-200">
              <div className="break-words">{error}</div>
              {attempts.length > 0 && (
                <div className="text-xs text-rose-200/70">
                  Tried {attempts.length} engine{attempts.length === 1 ? '' : 's'}; see the trace on the left for details.
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* ================================================================== */
/*  Sub-components                                                     */
/* ================================================================== */

function EnginePill({
  id,
  label,
  description,
  active,
  configured,
  onClick,
}: {
  id: string;
  label: string;
  description: string;
  active: boolean;
  configured: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={description}
      disabled={!configured && id !== 'auto'}
      className={[
        'rounded-full border px-3 py-1.5 text-xs font-medium transition',
        active
          ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200'
          : configured || id === 'auto'
            ? 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'
            : 'cursor-not-allowed border-white/8 bg-white/[0.02] text-white/30',
      ].join(' ')}
    >
      {label}
      {!configured && id !== 'auto' && (
        <span className="ml-1 text-[10px] text-white/25">(not configured)</span>
      )}
    </button>
  );
}

function PlanField({
  label,
  value,
  compact,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  if (!value) return null;
  return (
    <div className={compact ? '' : 'space-y-1'}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-emerald-200/70">
        {label}
      </div>
      <div className="text-sm leading-snug text-white/75">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function StatusBadge({ stage }: { stage: 'idle' | 'sequence' | 'folding' | 'rendered' }) {
  const label =
    stage === 'idle'
      ? 'Idle'
      : stage === 'sequence'
        ? 'Extracting'
        : stage === 'folding'
          ? 'Folding'
          : 'Rendered';

  return (
    <div className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs uppercase tracking-wider text-emerald-200">
      {label}
    </div>
  );
}

/* ── Inline SVG icons (tiny, no dep) ── */

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
