/**
 * Candidate verification — objective, model-free checks on a designed
 * peptide and its predicted structure.
 *
 * The Labs pipeline scores candidates with pLDDT blended with an LLM's
 * own opinion. Neither catches the failure mode that dominates generative
 * design: trivial sequences. An idealised poly-proline or `KLAVKLAD`
 * repeat folds to 90+ pLDDT because the predictor is certain about a rod,
 * not because the peptide is a plausible binder. Everything here is
 * deterministic arithmetic over the sequence and the Cα trace, so a
 * record's grade can be recomputed and disputed by anyone.
 *
 * A grade is a floor on credibility, never evidence of activity: nothing
 * in silico can establish that a design binds its target.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface VerificationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/**
 * `rejected` — fails a hard sanity check; must not be presented as a result.
 * `weak`     — plausible but with caveats (low complexity, no tertiary fold…).
 * `verified` — passes every objective check we can run without a wet lab.
 */
export type VerificationGrade = 'verified' | 'weak' | 'rejected';

export interface VerificationInput {
  sequence: string;
  /** Cα-only or full-atom PDB from the fold engine, when one exists. */
  pdb?: string | null;
  folded?: boolean;
  /** Sibling sequences (same run/goal) used for the novelty check. */
  peers?: readonly string[];
}

export interface VerificationMetrics {
  length: number;
  /** Shannon entropy of the residue distribution, in bits (max log2(20)≈4.32). */
  entropy: number;
  /** Fraction contributed by the single most frequent residue. */
  maxResidueFraction: number;
  /** Longest run of one residue. */
  longestRun: number;
  /** Fraction of the sequence explained by the best tandem repeat unit. */
  repeatFraction: number;
  /** Count of 12-residue windows below 1.8 bits (SEG-style low complexity). */
  lowComplexityWindows: number;
  /** Highest identity to a sibling sequence, 0 when there are no peers. */
  maxPeerIdentity: number;
  /** Mean/min pLDDT over Cα atoms, 0–100. Null without a structure. */
  plddtMean: number | null;
  plddtMin: number | null;
  /** Radius of gyration of the Cα trace, Å. Null without a structure. */
  radiusOfGyration: number | null;
  /** Rg expected for a globular domain of this length, Å. */
  expectedRadiusOfGyration: number | null;
  /** expectedRg / Rg — ~1 globular, «1 extended rod (single helix). */
  compactness: number | null;
  /** Cα pairs ≥12 apart in sequence and ≤8 Å apart in space, per residue. */
  longRangeContactDensity: number | null;
}

export interface VerificationResult {
  grade: VerificationGrade;
  /** Multiplier to apply to a model-reported score, in [0, 1]. */
  penalty: number;
  checks: VerificationCheck[];
  metrics: VerificationMetrics;
}

const CANONICAL = new Set('ACDEFGHIKLMNPQRSTVWY'.split(''));

const MIN_LENGTH = 8;
const MAX_LENGTH = 600;
const WINDOW = 12;

/* ------------------------------------------------------------------ */
/*  Sequence metrics                                                   */
/* ------------------------------------------------------------------ */

export function shannonEntropy(sequence: string): number {
  if (sequence.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of sequence) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = sequence.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function maxResidueFraction(sequence: string): number {
  if (sequence.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of sequence) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let max = 0;
  for (const c of counts.values()) max = Math.max(max, c);
  return max / sequence.length;
}

function longestRun(sequence: string): number {
  let best = 0;
  let run = 0;
  let prev = '';
  for (const ch of sequence) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Fraction of the sequence explained by the best tandem repeat of period
 * 1–12. `KLAVKLADKLAVKLAD…` returns ~1; a real design returns well below.
 */
export function repeatFraction(sequence: string): number {
  const n = sequence.length;
  if (n < 4) return 0;
  let best = 0;
  for (let k = 1; k <= Math.min(12, Math.floor(n / 2)); k++) {
    let matches = 0;
    for (let i = k; i < n; i++) {
      if (sequence[i] === sequence[i - k]) matches += 1;
    }
    best = Math.max(best, matches / (n - k));
  }
  return best;
}

function lowComplexityWindows(sequence: string): number {
  if (sequence.length < WINDOW) return 0;
  let count = 0;
  for (let i = 0; i + WINDOW <= sequence.length; i++) {
    if (shannonEntropy(sequence.slice(i, i + WINDOW)) < 1.8) count += 1;
  }
  return count;
}

/** Ungapped identity of two sequences over their overlapping prefix. */
export function sequenceIdentity(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same += 1;
  return same / Math.max(a.length, b.length);
}

/* ------------------------------------------------------------------ */
/*  Structure metrics                                                  */
/* ------------------------------------------------------------------ */

interface Ca {
  x: number;
  y: number;
  z: number;
  plddt: number;
}

export function parseCaAtoms(pdb: string): Ca[] {
  const pts: Ca[] = [];
  for (const line of pdb.split('\n')) {
    if (line.startsWith('ENDMDL')) break;
    if (!line.startsWith('ATOM')) continue;
    if (line.slice(12, 16).trim() !== 'CA') continue;
    const x = Number.parseFloat(line.slice(30, 38));
    const y = Number.parseFloat(line.slice(38, 46));
    const z = Number.parseFloat(line.slice(46, 54));
    const b = Number.parseFloat(line.slice(60, 66));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    pts.push({ x, y, z, plddt: Number.isFinite(b) ? b : 0 });
  }
  // ESM Atlas emits pLDDT on 0–1; NVIDIA/HF on 0–100.
  const maxB = pts.reduce((m, p) => Math.max(m, p.plddt), 0);
  if (maxB > 0 && maxB <= 1) for (const p of pts) p.plddt *= 100;
  return pts;
}

function radiusOfGyration(pts: readonly Ca[]): number {
  const n = pts.length;
  if (n === 0) return 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let sum = 0;
  for (const p of pts) {
    sum += (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2;
  }
  return Math.sqrt(sum / n);
}

/** Flory-style expectation for a compact globular domain of N residues. */
function expectedRg(n: number): number {
  return 2.2 * Math.pow(n, 0.38);
}

function longRangeContactDensity(pts: readonly Ca[]): number {
  const n = pts.length;
  if (n < 24) return 0;
  let contacts = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    for (let j = i + 12; j < n; j++) {
      const b = pts[j]!;
      const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
      if (d2 <= 64) contacts += 1;
    }
  }
  return contacts / n;
}

/* ------------------------------------------------------------------ */
/*  Verification                                                       */
/* ------------------------------------------------------------------ */

function worst(checks: readonly VerificationCheck[]): VerificationGrade {
  if (checks.some((c) => c.status === 'fail')) return 'rejected';
  if (checks.some((c) => c.status === 'warn')) return 'weak';
  return 'verified';
}

/**
 * Grade one candidate. Pure: same input always yields the same grade, so
 * the archive can be re-verified in bulk and the result audited.
 */
export function verifyCandidate(input: VerificationInput): VerificationResult {
  const sequence = (input.sequence ?? '').trim().toUpperCase();
  const checks: VerificationCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) =>
    checks.push({ id, label, status, detail });

  /* --- sequence sanity ------------------------------------------- */
  const nonCanonical = [...sequence].filter((ch) => !CANONICAL.has(ch));
  if (nonCanonical.length > 0) {
    add(
      'residues',
      'Canonical residues',
      'fail',
      `${nonCanonical.length} non-standard residue(s): ${[...new Set(nonCanonical)].join('')}`,
    );
  } else {
    add('residues', 'Canonical residues', 'pass', 'All 20-letter standard amino acids');
  }

  if (sequence.length < MIN_LENGTH || sequence.length > MAX_LENGTH) {
    add(
      'length',
      'Length',
      'fail',
      `${sequence.length} aa outside the designable ${MIN_LENGTH}–${MAX_LENGTH} aa range`,
    );
  } else {
    add('length', 'Length', 'pass', `${sequence.length} aa`);
  }

  const entropy = shannonEntropy(sequence);
  if (entropy < 1.8) {
    add(
      'complexity',
      'Sequence complexity',
      'fail',
      `${entropy.toFixed(2)} bits — near-homopolymer, folds confidently but carries no binding information`,
    );
  } else if (entropy < 2.5) {
    add('complexity', 'Sequence complexity', 'warn', `${entropy.toFixed(2)} bits — low diversity`);
  } else {
    add('complexity', 'Sequence complexity', 'pass', `${entropy.toFixed(2)} bits`);
  }

  const maxFraction = maxResidueFraction(sequence);
  if (maxFraction > 0.5) {
    add(
      'composition',
      'Composition bias',
      'fail',
      `${Math.round(maxFraction * 100)}% of residues are a single amino acid`,
    );
  } else if (maxFraction > 0.35) {
    add(
      'composition',
      'Composition bias',
      'warn',
      `${Math.round(maxFraction * 100)}% single-residue share`,
    );
  } else {
    add(
      'composition',
      'Composition bias',
      'pass',
      `${Math.round(maxFraction * 100)}% single-residue share`,
    );
  }

  const run = longestRun(sequence);
  if (run >= 8) {
    add('homopolymer', 'Homopolymer runs', 'fail', `${run}-residue run`);
  } else if (run >= 5) {
    add('homopolymer', 'Homopolymer runs', 'warn', `${run}-residue run`);
  } else {
    add('homopolymer', 'Homopolymer runs', 'pass', `longest run ${run}`);
  }

  const repeats = repeatFraction(sequence);
  if (repeats >= 0.8) {
    add(
      'repeats',
      'Tandem repeats',
      'fail',
      `${Math.round(repeats * 100)}% of the sequence is a repeating unit`,
    );
  } else if (repeats >= 0.55) {
    add('repeats', 'Tandem repeats', 'warn', `${Math.round(repeats * 100)}% repetitive`);
  } else {
    add('repeats', 'Tandem repeats', 'pass', `${Math.round(repeats * 100)}% repetitive`);
  }

  const lowWindows = lowComplexityWindows(sequence);
  if (lowWindows > 0) {
    add(
      'low-complexity',
      'Low-complexity regions',
      'warn',
      `${lowWindows} window(s) of ${WINDOW} aa below 1.8 bits`,
    );
  } else {
    add('low-complexity', 'Low-complexity regions', 'pass', 'none');
  }

  /* --- novelty ---------------------------------------------------- */
  let maxPeerIdentity = 0;
  for (const peer of input.peers ?? []) {
    const other = peer.trim().toUpperCase();
    if (!other || other === sequence) continue;
    maxPeerIdentity = Math.max(maxPeerIdentity, sequenceIdentity(sequence, other));
  }
  if (maxPeerIdentity >= 0.95) {
    add(
      'novelty',
      'Novelty vs. siblings',
      'fail',
      `${Math.round(maxPeerIdentity * 100)}% identical to another candidate in this run`,
    );
  } else if (maxPeerIdentity >= 0.85) {
    add(
      'novelty',
      'Novelty vs. siblings',
      'warn',
      `${Math.round(maxPeerIdentity * 100)}% identity to a sibling`,
    );
  } else {
    add('novelty', 'Novelty vs. siblings', 'pass', `${Math.round(maxPeerIdentity * 100)}% identity`);
  }

  /* --- structure -------------------------------------------------- */
  const pts = input.pdb ? parseCaAtoms(input.pdb) : [];
  let plddtMean: number | null = null;
  let plddtMin: number | null = null;
  let rg: number | null = null;
  let rgExpected: number | null = null;
  let compactness: number | null = null;
  let contactDensity: number | null = null;

  if (pts.length === 0) {
    add(
      'structure',
      'Predicted structure',
      'warn',
      input.folded ? 'marked folded but no coordinates stored' : 'no structure predicted',
    );
  } else {
    plddtMean = pts.reduce((s, p) => s + p.plddt, 0) / pts.length;
    plddtMin = pts.reduce((m, p) => Math.min(m, p.plddt), Infinity);
    rg = radiusOfGyration(pts);
    rgExpected = expectedRg(pts.length);
    compactness = rg > 0 ? rgExpected / rg : null;
    contactDensity = longRangeContactDensity(pts);

    if (plddtMean < 50) {
      add('plddt', 'Fold confidence', 'fail', `mean pLDDT ${plddtMean.toFixed(0)}`);
    } else if (plddtMean < 70) {
      add('plddt', 'Fold confidence', 'warn', `mean pLDDT ${plddtMean.toFixed(0)}`);
    } else {
      add('plddt', 'Fold confidence', 'pass', `mean pLDDT ${plddtMean.toFixed(0)}`);
    }

    // A single straight helix has an Rg far above a globular domain's and
    // zero long-range contacts — pLDDT says nothing about this.
    if (pts.length >= 30) {
      const extended = compactness !== null && compactness < 0.55;
      if (extended && (contactDensity ?? 0) === 0) {
        add(
          'tertiary',
          'Tertiary structure',
          'fail',
          `extended rod (Rg ${rg.toFixed(1)} Å vs ${rgExpected.toFixed(1)} Å expected), no long-range contacts`,
        );
      } else if ((contactDensity ?? 0) < 0.1) {
        add(
          'tertiary',
          'Tertiary structure',
          'warn',
          `few long-range contacts (${(contactDensity ?? 0).toFixed(2)}/residue) — single secondary-structure element`,
        );
      } else {
        add(
          'tertiary',
          'Tertiary structure',
          'pass',
          `${(contactDensity ?? 0).toFixed(2)} long-range contacts/residue, Rg ${rg.toFixed(1)} Å`,
        );
      }
    }
  }

  const grade = worst(checks);
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const penalty =
    grade === 'rejected' ? 0 : grade === 'verified' ? 1 : Math.max(0.35, 1 - 0.18 * warnCount);

  return {
    grade,
    penalty,
    checks,
    metrics: {
      length: sequence.length,
      entropy,
      maxResidueFraction: maxFraction,
      longestRun: run,
      repeatFraction: repeats,
      lowComplexityWindows: lowWindows,
      maxPeerIdentity,
      plddtMean,
      plddtMin: plddtMin === Infinity ? null : plddtMin,
      radiusOfGyration: rg,
      expectedRadiusOfGyration: rgExpected,
      compactness,
      longRangeContactDensity: contactDensity,
    },
  };
}

/** Short human-readable reason a candidate was downgraded, for UI/API. */
export function verificationSummary(result: VerificationResult): string {
  const bad = result.checks.filter((c) => c.status !== 'pass');
  if (bad.length === 0) return 'Passes all objective sequence and structure checks';
  return bad.map((c) => `${c.label}: ${c.detail}`).join('; ');
}
