/**
 * Archive-side glue for candidate verification.
 *
 * Grades every candidate of a completed run with the objective checks in
 * `@etica-hub/shared/labs/verify`, then re-ranks the run's best candidate
 * by verification-adjusted score — so a 92-pLDDT poly-proline rod can no
 * longer be published as the headline result of a research job.
 */

import {
  verifyCandidate,
  verificationSummary,
  type VerificationGrade,
  type VerificationCheck,
} from '@etica-hub/shared/labs/verify';

import { getPdbForSequence, type ArchivedCandidate } from './archive';

/** Compact record persisted alongside each archived candidate. */
export interface CandidateVerification {
  grade: VerificationGrade;
  /** Score multiplier applied to the model-reported score. */
  penalty: number;
  /** Model score × penalty, the value used for ranking. */
  adjustedScore: number;
  summary: string;
  checks: Array<Pick<VerificationCheck, 'id' | 'label' | 'status' | 'detail'>>;
}

export interface VerifiableCandidate {
  index: number;
  sequence: string;
  score?: number;
  folded?: boolean;
}

/**
 * Verify a whole run. `pdbFor` resolves a candidate index to its PDB;
 * candidates without one are still graded on sequence alone.
 */
export function verifyRun<T extends VerifiableCandidate>(
  candidates: readonly T[],
  pdbFor: (candidate: T) => string | null | undefined,
): Map<number, CandidateVerification> {
  const sequences = candidates.map((c) => c.sequence);
  const out = new Map<number, CandidateVerification>();
  candidates.forEach((candidate, i) => {
    const peers = sequences.filter((_, j) => j !== i);
    const result = verifyCandidate({
      sequence: candidate.sequence,
      pdb: pdbFor(candidate),
      folded: candidate.folded,
      peers,
    });
    out.set(candidate.index, {
      grade: result.grade,
      penalty: result.penalty,
      adjustedScore: (candidate.score ?? 0) * result.penalty,
      summary: verificationSummary(result),
      checks: result.checks,
    });
  });
  return out;
}

/**
 * Pick the candidate a run should be published under: highest
 * verification-adjusted score, falling back to raw score when every
 * candidate was rejected (the run is then archived, and labelled, as
 * having produced nothing that survives verification).
 */
export function pickBestCandidate<T extends VerifiableCandidate>(
  candidates: readonly T[],
  verifications: ReadonlyMap<number, CandidateVerification>,
): T {
  const first = candidates[0]!;
  return candidates.reduce((best, c) => {
    const a = verifications.get(c.index)?.adjustedScore ?? 0;
    const b = verifications.get(best.index)?.adjustedScore ?? 0;
    if (a !== b) return a > b ? c : best;
    return (c.score ?? 0) > (best.score ?? 0) ? c : best;
  }, first);
}

/** Grade of a run = grade of its published best candidate. */
export function runGrade(
  best: VerifiableCandidate,
  verifications: ReadonlyMap<number, CandidateVerification>,
): VerificationGrade {
  return verifications.get(best.index)?.grade ?? 'weak';
}

/**
 * Re-verify an already archived record using the Cα traces kept under
 * `labs:archive:pdb:{seqHash}`. Used by the backfill route; mutates and
 * returns the candidates with their verification attached.
 */
export async function verifyArchivedCandidates(
  candidates: readonly ArchivedCandidate[],
  bestPdb?: string,
  bestSequence?: string,
): Promise<Map<number, CandidateVerification>> {
  const pdbs = new Map<number, string | null>();
  for (const c of candidates) {
    if (bestPdb && bestSequence && c.sequence === bestSequence) {
      pdbs.set(c.index, bestPdb);
      continue;
    }
    pdbs.set(c.index, await getPdbForSequence(c.sequence));
  }
  return verifyRun(candidates, (c) => pdbs.get(c.index));
}
