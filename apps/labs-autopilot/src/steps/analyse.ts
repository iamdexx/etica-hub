/**
 * Groq-powered structural analysis + a coarse score in [0, 1].
 *
 * The analysis prompt is intentionally small — we don't ship the full
 * PDB to Groq, just a short summary (length, ATOM count, B-factor mean,
 * range of pLDDT-ish confidence values where available). This keeps the
 * Groq call fast and free-tier friendly, and the analysis useful enough
 * to drive iteration ranking.
 */

import {
  groqChat,
  GroqError,
  GROQ_MODEL_FALLBACK,
  GROQ_MODEL_PRIMARY,
  readGroqKeyPool,
} from '../groq';

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

function parseScoreFromText(text: string): number | null {
  // Look for "score: 0.42" or "Score=0.42" — Groq is asked to emit one.
  const m = text.match(/score\s*[:=]\s*(0(?:\.\d+)?|1(?:\.0+)?)/i);
  if (!m || !m[1]) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

export async function analyseStructure(sequence: string, pdb: string): Promise<Analysis> {
  if (readGroqKeyPool().length === 0) {
    throw new Error('GROQ_API_KEY (or GROQ_API_KEYS) not set');
  }

  const s = summarizePdb(pdb);
  const confidence = pdbConfidenceScore(s);

  const systemPrompt = [
    'You are a structural biologist reviewing an ESMFold prediction.',
    'Given a peptide sequence and a short PDB summary, write a 2-3 sentence analysis covering:',
    '(a) likely secondary structure (helix/sheet/loop balance),',
    '(b) overall confidence (high/medium/low) based on pLDDT,',
    '(c) any obvious structural risk (kink, exposed hydrophobic, etc.).',
    'End your analysis with a single line: `Score: <number from 0 to 1>` where',
    '0 means useless and 1 means a publication-quality prediction.',
    'Be terse. No markdown, no JSON.',
  ].join(' ');

  const summary = [
    `Sequence (${sequence.length} aa): ${sequence}`,
    `Residues in PDB: ${s.length}`,
    `Atoms: ${s.atomCount}`,
    `B-factor (pLDDT) mean: ${s.bMean.toFixed(1)} (min ${s.bMin.toFixed(1)}, max ${s.bMax.toFixed(
      1,
    )})`,
    `HELIX records: ${s.helixHint}, SHEET records: ${s.sheetHint}`,
  ].join('\n');

  // groqChat handles retry/key-rotation/model-cascade automatically. If
  // Groq is fully exhausted we fall back to a deterministic objective-only
  // summary so analysis never blocks the worker pipeline.
  try {
    const result = await groqChat({
      models: [GROQ_MODEL_FALLBACK, GROQ_MODEL_PRIMARY],
      temperature: 0.3,
      max_tokens: 350,
      timeoutMs: 25_000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: summary },
      ],
    });
    const raw = result.content;
    const parsed = parseScoreFromText(raw);
    // Blend Groq's qualitative score with the objective pLDDT confidence
    // 60/40 so a low-confidence fold can't be talked up.
    const score = parsed === null ? confidence : parsed * 0.6 + confidence * 0.4;
    return { summary: raw.replace(/score\s*[:=].*$/i, '').trim(), score };
  } catch (err) {
    if (err instanceof GroqError) {
      // Worker must never block on Groq — emit an objective-only summary so
      // the candidate can still be ranked + published downstream.
      const fallback = [
        `Objective summary only (Groq unavailable: ${err.status || 'network'}).`,
        `Predicted ${s.length} residues, ${s.atomCount} atoms.`,
        `Mean pLDDT ${s.bMean.toFixed(1)} (range ${s.bMin.toFixed(1)}–${s.bMax.toFixed(1)}).`,
        `HELIX records: ${s.helixHint}, SHEET records: ${s.sheetHint}.`,
      ].join(' ');
      return { summary: fallback, score: confidence };
    }
    throw err;
  }
}
