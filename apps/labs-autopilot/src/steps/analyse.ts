/**
 * Nvidia Nemotron structural analysis + a coarse score in [0, 1].
 *
 * The analysis prompt is intentionally small — we don't ship the full
 * PDB to the LLM, just a short summary (length, ATOM count, B-factor mean,
 * range of pLDDT-ish confidence values where available). This keeps the
 * call fast and the analysis useful enough to drive iteration ranking.
 */

import {
  nvidiaChat,
  NvidiaLLMError,
  NVIDIA_MODEL_FALLBACK,
  NVIDIA_MODEL_PRIMARY,
  hasLLMProxy,
} from '../nvidia';

export type Analysis = {
  summary: string;
  score: number;
};

type PdbSummary = {
  length: number;
  atomCount: number;
  bMean: number;
  bMin: number;
  bMax: number;
  helixHint: number;
  sheetHint: number;
};

function summarizePdb(pdb: string): PdbSummary {
  let atomCount = 0;
  let bSum = 0;
  let bCount = 0;
  let bMin = Infinity;
  let bMax = -Infinity;
  let helixHint = 0;
  let sheetHint = 0;
  let residueIds = new Set<string>();

  const lines = pdb.split('\n');
  for (const line of lines) {
    if (line.startsWith('ATOM')) {
      atomCount += 1;
      // B-factor / pLDDT column: 60-65 (PDB fixed format).
      const b = parseFloat(line.slice(60, 66));
      if (Number.isFinite(b)) {
        bSum += b;
        bCount += 1;
        if (b < bMin) bMin = b;
        if (b > bMax) bMax = b;
      }
      const chain = line.slice(21, 22);
      const resNum = line.slice(22, 26).trim();
      residueIds.add(`${chain}:${resNum}`);
    } else if (line.startsWith('HELIX')) {
      helixHint += 1;
    } else if (line.startsWith('SHEET')) {
      sheetHint += 1;
    }
  }

  return {
    length: residueIds.size,
    atomCount,
    bMean: bCount > 0 ? bSum / bCount : 0,
    bMin: Number.isFinite(bMin) ? bMin : 0,
    bMax: Number.isFinite(bMax) ? bMax : 0,
    helixHint,
    sheetHint,
  };
}

function pdbConfidenceScore(s: PdbSummary): number {
  // ESMFold writes pLDDT (0-100) into the B-factor column. Treat the mean
  // as a coarse confidence; map to [0, 1].
  if (s.bMean <= 0) return 0.5;
  return Math.max(0, Math.min(1, s.bMean / 100));
}

function sizeNoun(residues: number): string {
  if (residues < 50) return 'small designed protein';
  if (residues < 150) return 'designed protein';
  return 'large designed protein';
}

/**
 * A short, jargon-free description of a folded candidate, built only from
 * facts we can trust (length + mean pLDDT). This is what the feed shows.
 *
 * We deliberately do NOT store the LLM's prose: Nemotron 550B narrates its
 * reasoning ("The user wants me to…") even with "detailed thinking off", and
 * that leaked verbatim into the feed. Keep this in sync with the web copy at
 * apps/web/src/lib/labs/plain-summary.ts.
 */
function buildPlainSummary(s: PdbSummary): string {
  const residues = s.length;
  const mean = Math.round(s.bMean);
  const confidenceClause =
    s.bMean >= 80
      ? 'The AI fold model is highly confident in the predicted 3D shape'
      : s.bMean >= 60
        ? 'The AI fold model is moderately confident in the predicted 3D shape'
        : 'The AI fold model has low confidence in the predicted 3D shape, so treat it as an early lead';

  let out = `A ${sizeNoun(residues)}, ${residues} amino acids long. ${confidenceClause} (${mean}/100).`;
  if (s.bMin < 50 && s.bMean >= 60) {
    out += ' Part of the chain is less certain and may be flexible.';
  }
  return out;
}

function parseScoreFromText(text: string): number | null {
  // Look for "score: 0.42" or "Score=0.42" — the LLM is asked to emit one.
  const m = text.match(/score\s*[:=]\s*(0(?:\.\d+)?|1(?:\.0+)?)/i);
  if (!m || !m[1]) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

export async function analyseStructure(sequence: string, pdb: string): Promise<Analysis> {
  if (!hasLLMProxy()) {
    throw new Error('LABS_AUTOPILOT_TOKEN not set — cannot reach LLM proxy');
  }

  const s = summarizePdb(pdb);
  const confidence = pdbConfidenceScore(s);

  // What the feed shows is ALWAYS this clean, deterministic sentence — never
  // the model's prose. The LLM below is used only to refine the numeric score.
  const summary = buildPlainSummary(s);

  // Ask only for a score, on a single line. 'detailed thinking off' is sent as
  // its OWN system message — concatenated with other text 550B ignores it.
  const systemPrompt = [
    'You are a structural biologist scoring an ESMFold prediction.',
    'Given a peptide sequence and a short PDB summary, judge how usable the predicted structure is.',
    'Reply with ONLY one line: `Score: <number from 0 to 1>` where 0 means useless',
    'and 1 means a publication-quality prediction. No prose, no explanation, no markdown.',
  ].join(' ');

  const factSummary = [
    `Sequence (${sequence.length} aa): ${sequence}`,
    `Residues in PDB: ${s.length}`,
    `Atoms: ${s.atomCount}`,
    `B-factor (pLDDT) mean: ${s.bMean.toFixed(1)} (min ${s.bMin.toFixed(1)}, max ${s.bMax.toFixed(
      1,
    )})`,
    `HELIX records: ${s.helixHint}, SHEET records: ${s.sheetHint}`,
  ].join('\n');

  // nvidiaChat handles retry/model-cascade automatically. If Nvidia is fully
  // exhausted we keep the deterministic summary and fall back to the objective
  // pLDDT confidence as the score, so analysis never blocks the pipeline.
  try {
    const result = await nvidiaChat({
      models: [NVIDIA_MODEL_FALLBACK, NVIDIA_MODEL_PRIMARY],
      temperature: 0.3,
      max_tokens: 60,
      timeoutMs: 60_000,
      messages: [
        { role: 'system', content: 'detailed thinking off' },
        { role: 'system', content: systemPrompt },
        { role: 'user', content: factSummary },
      ],
    });
    const parsed = parseScoreFromText(result.content);
    // Blend the LLM's qualitative score with the objective pLDDT confidence
    // 60/40 so a low-confidence fold can't be talked up.
    const score = parsed === null ? confidence : parsed * 0.6 + confidence * 0.4;
    return { summary, score };
  } catch (err) {
    if (err instanceof NvidiaLLMError) {
      return { summary, score: confidence };
    }
    throw err;
  }
}
