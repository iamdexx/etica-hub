/**
 * On-chain "branch goal id" helpers.
 *
 * EticaResearchNFT enforces one mint per unique `branchGoalId`
 * (`branchClaimed[keccak256(branchGoalId)]`). A single research goal yields
 * many candidates that are each independently mintable, so the branch id has
 * to be scoped to the candidate — not just the goal. Keying every candidate
 * on the bare goal id lets only the first candidate of a goal ever be
 * claimed; every other one reverts with `BranchAlreadyClaimed`.
 *
 * Canonical form: `${goalId}#${candidateIndex}`. Goal ids are UUIDs and never
 * contain '#', so the goal id stays recoverable (split on the final '#') for
 * feed nesting. Records minted before per-candidate ids stored a bare
 * `${goalId}`; those parse back to a candidate-less id and keep resolving.
 */
export function discoveryBranchId(goalId: string, candidateIndex: number): string {
  return `${goalId}#${candidateIndex}`;
}

export interface ParsedDiscoveryBranchId {
  goalId: string;
  candidateIndex?: number;
}

export function parseDiscoveryBranchId(branchId: string): ParsedDiscoveryBranchId {
  const hash = branchId.lastIndexOf('#');
  if (hash > 0 && hash < branchId.length - 1) {
    const suffix = branchId.slice(hash + 1);
    if (/^\d+$/.test(suffix)) {
      return { goalId: branchId.slice(0, hash), candidateIndex: Number(suffix) };
    }
  }
  return { goalId: branchId };
}

/**
 * The cascade anchor a child discovery points at: its parent's exact on-chain
 * branch id. Falls back to the bare parent goal id for legacy parents minted
 * before per-candidate ids (their `branchGoalId` was the bare goal id).
 */
export function parentDiscoveryBranchId(
  parentGoalId: string | undefined,
  parentCandidateIndex: number | undefined,
): string {
  if (!parentGoalId) return '';
  return typeof parentCandidateIndex === 'number'
    ? discoveryBranchId(parentGoalId, parentCandidateIndex)
    : parentGoalId;
}
