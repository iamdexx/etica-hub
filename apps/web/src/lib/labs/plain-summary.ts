/**
 * Plain-language helpers for the Labs feed.
 *
 * The autopilot pipeline is full of structural-biology jargon (pLDDT,
 * ESMFold, residues, secondary structure) and the LLM analysis step used
 * to dump its raw chain-of-thought ("The user wants me to…") straight into
 * the feed. These helpers turn the few objective facts we actually have —
 * how long the protein is and how confident the fold model was — into a
 * short, jargon-free sentence a non-scientist can read, plus a simple
 * High / Medium / Low confidence tier.
 *
 * Pure functions (no DOM, no I/O) so they can run client-side in the feed,
 * server-side when archiving, and in the Redis backfill script alike.
 */

export type ConfidenceLabel = 'High' | 'Medium' | 'Low';

export interface ConfidenceTier {
  label: ConfidenceLabel;
  /** 0–100 fold-model confidence (mean pLDDT), rounded for display. */
  score: number;
  /** Tailwind classes for a coloured pill. */
  badgeClass: string;
}

/**
 * Map a mean pLDDT (0–100) to a plain High / Medium / Low tier. ESMFold and
 * AlphaFold treat >90 as very high and >70 as confident; we collapse that to
 * three buckets a layperson can reason about.
 */
export function confidenceTier(meanPlddt: number): ConfidenceTier {
  const score = Math.round(meanPlddt);
  if (meanPlddt >= 80) {
    return {
      label: 'High',
      score,
      badgeClass: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
    };
  }
  if (meanPlddt >= 60) {
    return {
      label: 'Medium',
      score,
      badgeClass: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
    };
  }
  return {
    label: 'Low',
    score,
    badgeClass: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  };
}

export interface PlainSummaryFacts {
  /** Number of residues (amino acids) in the predicted structure. */
  residues: number;
  meanPlddt: number;
  minPlddt?: number;
  maxPlddt?: number;
}

function sizeNoun(residues: number): string {
  if (residues < 50) return 'small designed protein';
  if (residues < 150) return 'designed protein';
  return 'large designed protein';
}

/**
 * A short, jargon-free description of a folded candidate, built only from
 * facts we can trust (length + fold-model confidence). Deliberately makes
 * no claim about helices/sheets — the ESMFold PDBs this pipeline stores
 * carry no secondary-structure records, so any such claim would be a guess.
 */
export function buildPlainSummary(facts: PlainSummaryFacts): string {
  const { residues, meanPlddt, minPlddt } = facts;
  const tier = confidenceTier(meanPlddt);

  const confidenceClause =
    tier.label === 'High'
      ? 'The AI fold model is highly confident in the predicted 3D shape'
      : tier.label === 'Medium'
        ? 'The AI fold model is moderately confident in the predicted 3D shape'
        : 'The AI fold model has low confidence in the predicted 3D shape, so treat it as an early lead';

  let out = `A ${sizeNoun(residues)}, ${residues} amino acids long. ${confidenceClause} (${tier.score}/100).`;

  if (
    typeof minPlddt === 'number' &&
    Number.isFinite(minPlddt) &&
    minPlddt < 50 &&
    meanPlddt >= 60
  ) {
    out += ' Part of the chain is less certain and may be flexible.';
  }
  return out;
}

/** Plain-language label for the 0–1 candidate score shown on each card. */
export function scoreLabel(score: number): string {
  if (score >= 0.8) return 'Strong';
  if (score >= 0.6) return 'Promising';
  if (score >= 0.4) return 'Mixed';
  return 'Weak';
}

/**
 * Markers that betray raw LLM chain-of-thought rather than a finished
 * answer. Used to detect (and in the backfill, discard) the old
 * "The user wants me to…" analyses.
 */
const NARRATION_MARKERS = [
  'the user wants',
  'the user is asking',
  'the user asked',
  'let me analyze',
  'let me think',
  "let's analyze",
  'i need to',
  'i should',
  'first,',
  'okay,',
  'key observations',
  'analysis points',
  'step 1',
  'reasoning:',
  'thinking:',
];

/**
 * True when a stored analysis string looks like leaked model reasoning
 * rather than a clean summary. Conservative — only flags the obvious tells
 * the old prompt produced.
 */
export function looksLikeNarration(text: string | undefined | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return NARRATION_MARKERS.some((m) => lower.includes(m));
}
