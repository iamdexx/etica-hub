/**
 * Sequence-only fallback score used when every folding engine has
 * exhausted retries. Mint never blocks on fold quality: a candidate
 * can be published with `structurePending: true` and a coarse score
 * derived purely from the peptide sequence + parent-goal text + the
 * existing per-goal corpus.
 *
 * Score is in [0, 1] and bakes three signals:
 *   1. Length validity. ESMFold practically caps near ~600 aa; useful
 *      research peptides cluster at 8-60 aa. Anything well outside that
 *      band is heavily penalised.
 *   2. Composition sanity. The 20 canonical amino acids should dominate;
 *      a sequence full of `X`/non-canonical letters scores lower.
 *   3. Novelty + parent-goal alignment. We mix in a small lexical signal
 *      from the prompt so a sequence chosen for a relevant goal is
 *      preferred over a generic one.
 *
 * The output is intentionally conservative: a perfect sequence-only
 * score caps at 0.55 so structure-backed scores (which can hit 1.0)
 * always rank above pending ones during downstream ranking.
 */

const CANONICAL_AAS = 'ACDEFGHIKLMNPQRSTVWY';
const CANONICAL_SET = new Set(CANONICAL_AAS.split(''));

const IDEAL_MIN = 8;
const IDEAL_MAX = 60;
const HARD_MIN = 4;
const HARD_MAX = 600;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function lengthScore(sequence: string): number {
  const n = sequence.length;
  if (n < HARD_MIN || n > HARD_MAX) return 0;
  if (n >= IDEAL_MIN && n <= IDEAL_MAX) return 1;
  if (n < IDEAL_MIN) {
    return (n - HARD_MIN) / (IDEAL_MIN - HARD_MIN);
  }
  return Math.max(0, 1 - (n - IDEAL_MAX) / (HARD_MAX - IDEAL_MAX));
}

function compositionScore(sequence: string): number {
  if (sequence.length === 0) return 0;
  let canonical = 0;
  for (const ch of sequence) {
    if (CANONICAL_SET.has(ch.toUpperCase())) canonical += 1;
  }
  return canonical / sequence.length;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4) tokens.add(raw);
  }
  return tokens;
}

function alignmentScore(prompt: string | undefined, rationale: string | undefined): number {
  if (!prompt) return 0.5;
  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) return 0.5;
  const rationaleTokens = tokenize(rationale ?? '');
  if (rationaleTokens.size === 0) return 0.5;
  let overlap = 0;
  for (const token of rationaleTokens) {
    if (promptTokens.has(token)) overlap += 1;
  }
  // Jaccard-ish overlap, capped at 1.
  const denom = Math.max(promptTokens.size, rationaleTokens.size);
  return clamp01(overlap / Math.max(1, denom));
}

function noveltyScore(sequence: string, peers: readonly string[]): number {
  if (peers.length === 0) return 1;
  let bestSimilarity = 0;
  for (const peer of peers) {
    if (!peer) continue;
    const sim = lexicalSimilarity(sequence, peer);
    if (sim > bestSimilarity) bestSimilarity = sim;
  }
  return clamp01(1 - bestSimilarity);
}

/**
 * Cheap k-gram overlap as a proxy for sequence similarity. We do not
 * need a true alignment here — the goal is to penalise candidates that
 * are near-duplicates of already-minted research without dragging in a
 * heavy bioinformatics dependency.
 */
function lexicalSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const k = 4;
  if (a.length < k || b.length < k) return a === b ? 1 : 0;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - k; i += 1) set.add(s.slice(i, i + k));
    return set;
  };
  const A = grams(a.toUpperCase());
  const B = grams(b.toUpperCase());
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface SequenceOnlyScoreInput {
  sequence: string;
  prompt?: string;
  rationale?: string;
  peerSequences?: readonly string[];
}

export interface SequenceOnlyScoreOutput {
  score: number;
  summary: string;
}

export function sequenceOnlyScore(input: SequenceOnlyScoreInput): SequenceOnlyScoreOutput {
  const lenS = lengthScore(input.sequence);
  const compS = compositionScore(input.sequence);
  const novS = noveltyScore(input.sequence, input.peerSequences ?? []);
  const alignS = alignmentScore(input.prompt, input.rationale);

  // Weighted sum, then clamp to the conservative 0.55 ceiling so this
  // never outranks an honest folded score.
  const raw = lenS * 0.4 + compS * 0.2 + novS * 0.25 + alignS * 0.15;
  const score = clamp01(raw) * 0.55;

  const summary = [
    'Sequence-only score (no structure available):',
    `length=${input.sequence.length}aa (${lenS.toFixed(2)})`,
    `composition=${compS.toFixed(2)}`,
    `novelty=${novS.toFixed(2)}`,
    `alignment=${alignS.toFixed(2)}`,
    'Structure pending re-fold.',
  ].join(' · ');

  return { score, summary };
}
