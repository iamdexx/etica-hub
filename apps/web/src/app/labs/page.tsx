'use client';

import { useMemo, useRef, useState } from 'react';

const MAX_PROMPT_CHARS = 400;

export default function LabsPage() {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = useState('Design a stable 40 amino acid peptide beginning with MVL that improves thermal resilience.');
  const [sequence, setSequence] = useState('');
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<'idle' | 'sequence' | 'folding' | 'rendered'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pdb, setPdb] = useState<string | null>(null);

  const charsRemaining = useMemo(() => MAX_PROMPT_CHARS - prompt.length, [prompt.length]);

  async function renderMolecule(pdbText: string): Promise<void> {
    if (!viewerRef.current) return;

    const win = window as typeof window & {
      $3Dmol?: {
        createViewer: (element: HTMLElement, options?: Record<string, unknown>) => {
          addModel: (data: string, format: string) => void;
          setStyle: (selector: Record<string, unknown>, style: Record<string, unknown>) => void;
          zoomTo: () => void;
          render: () => void;
          spin: (enabled: boolean) => void;
        };
      };
    };

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

    const viewer = win.$3Dmol?.createViewer(viewerRef.current, {
      backgroundColor: '#020806',
    });

    viewer?.addModel(pdbText, 'pdb');
    viewer?.setStyle({}, { cartoon: { color: 'spectrum' } });
    viewer?.zoomTo();
    viewer?.render();
    viewer?.spin(true);
  }

  async function handleGenerate(): Promise<void> {
    setLoading(true);
    setError(null);
    setPdb(null);
    setSequence('');

    try {
      setStage('sequence');

      const seqResponse = await fetch('/api/labs/sequence', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
      });

      const seqPayload = await seqResponse.json();

      if (!seqResponse.ok) {
        throw new Error(seqPayload.error ?? 'Failed to generate sequence.');
      }

      setSequence(seqPayload.sequence);
      setStage('folding');

      const foldResponse = await fetch('/api/labs/fold', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sequence: seqPayload.sequence }),
      });

      const foldPayload = await foldResponse.json();

      if (!foldResponse.ok) {
        throw new Error(foldPayload.error ?? 'Failed to fold sequence.');
      }

      setPdb(foldPayload.pdb);
      await renderMolecule(foldPayload.pdb);
      setStage('rendered');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected Labs error.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 md:px-6">
      <section className="rounded-3xl border border-emerald-400/20 bg-[#04110d] p-6 shadow-2xl shadow-emerald-950/20">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-emerald-300">
              Etica Labs · AI Protein Studio
            </div>

            <h1 className="text-4xl font-semibold tracking-tight text-white md:text-5xl">
              Generate peptide structures with Groq + ESMFold.
            </h1>

            <p className="text-base text-white/70 md:text-lg">
              Natural-language peptide design, ultra-fast sequence extraction via Groq, automatic ESMFold structure prediction, and real-time WebGL molecular rendering with 3Dmol.js.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="LLM" value="Groq" />
            <Metric label="Folding" value="ESMFold" />
            <Metric label="Rendering" value="3Dmol.js" />
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.92fr_1.08fr]">
        <div className="space-y-5 rounded-3xl border border-white/10 bg-[#050b09] p-5">
          <div>
            <div className="text-sm font-medium text-white">Prompt</div>
            <div className="mt-1 text-sm text-white/55">
              Describe the peptide or paste an amino-acid sequence. Inputs are capped to protect the free-tier inference infrastructure.
            </div>
          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_CHARS))}
            className="min-h-[220px] w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white outline-none ring-0 transition focus:border-emerald-400/40"
            placeholder="Design a 40 amino acid peptide beginning with MVL..."
          />

          <div className="flex items-center justify-between text-xs text-white/45">
            <span>Max {MAX_PROMPT_CHARS} characters</span>
            <span>{charsRemaining} remaining</span>
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading || prompt.trim().length === 0}
            className="inline-flex items-center justify-center rounded-full bg-brand-accent px-5 py-3 text-sm font-medium text-brand-ink transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Generating structure…' : 'Generate molecule'}
          </button>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/70">
            <div className="font-medium text-white">Pipeline</div>
            <ol className="mt-3 space-y-2 text-white/60">
              <li>1. Prompt → Groq sequence extraction</li>
              <li>2. Sequence → Hugging Face ESMFold</li>
              <li>3. PDB → 3Dmol.js render</li>
            </ol>
          </div>
        </div>

        <div className="space-y-5 rounded-3xl border border-white/10 bg-[#050b09] p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-white">Molecular Viewer</div>
              <div className="mt-1 text-sm text-white/55">
                Interactive WebGL visualization rendered directly in-browser.
              </div>
            </div>

            <StatusBadge stage={stage} />
          </div>

          <div
            ref={viewerRef}
            className="h-[540px] overflow-hidden rounded-3xl border border-emerald-400/15 bg-[#020806]"
          >
            {!pdb && (
              <div className="flex h-full items-center justify-center text-center text-sm text-white/40">
                {loading ? 'Preparing protein structure…' : 'Your folded molecule will render here.'}
              </div>
            )}
          </div>

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
                <div>ESMFold inference: serverless</div>
                <div>3D renderer: active</div>
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-200">
              {error}
            </div>
          )}
        </div>
      </section>
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
