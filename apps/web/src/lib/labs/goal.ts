/**
 * Persistent research-goal abstraction for EticaLabs.
 *
 * A "goal" is a long-running research objective (e.g. "cure for ovarian
 * cancer") that aggregates many one-shot autopilot jobs. Each new run
 * attached to a goal receives prior-iteration context + cross-goal
 * candidates from related goals before planning, so the planner builds
 * on accumulated work instead of starting fresh.
 *
 * Storage is Redis-backed; see {@link labsQueue} for the adapter layer.
 *
 * Cross-linking is keyword-based for v1 — cheap, no embeddings:
 * a normalised token list per goal feeds a `keyword → goalIds` SET
 * index, and "related" = top-N other goals sharing the most tokens.
 *
 * Moderation: every goal has the same lifecycle as a job — see
 * {@link ModerationStatus} in `./moderation`. Goals start `visible`
 * unless the hard denylist or biomedical-gate trips at submit time.
 */
import type { ModerationStatus } from './moderation';

export interface LabsGoal {
  id: string;
  title: string;
  description: string;
  /** Normalised lowercase keyword tokens; used for cross-goal linking. */
  keywords: string[];
  createdAt: number;
  updatedAt: number;
  /** Total job count attached to this goal (running + completed). */
  runCount: number;
  /** Timestamp of most recent attached run (any status). */
  lastRunAt: number;
  /** Submitter IP-hash (12 chars). 'anon' if not derivable. */
  submitterTag: string;
  /** Submitter EIP-191-signed wallet address (chain 61803), required on every new goal. */
  submitterWallet?: string;
  /** Community moderation status. Hidden goals are skipped by the worker. */
  moderation: ModerationStatus;
  /**
   * If set, this goal was auto-branched off a parent goal when one of
   * the parent's runs produced a high-scoring candidate worth dedicated
   * follow-up research. The parent stays expansive on its own thread
   * while the branch goal drills into that specific lead.
   */
  parentGoalId?: string;
  /** The job-id that triggered this branch (parent's winning run). */
  parentJobId?: string;
  /**
   * Index of the specific parent candidate this goal branched from. Combined
   * with {@link parentGoalId} it reconstructs the parent discovery's on-chain
   * `branchGoalId` (`${parentGoalId}#${parentCandidateIndex}`) so the NFT
   * royalty cascade anchors to the exact ancestor token. Undefined for root
   * goals and for branches off legacy (pre per-candidate) discoveries.
   */
  parentCandidateIndex?: number;
  /**
   * Origin marker. 'user' = submitted directly; 'branch' = auto-spawned
   * from a strong-scoring parent candidate. Used by the UI to render
   * branch trees and by the worker to attribute autopilot expansions.
   */
  origin?: 'user' | 'branch';
}

export interface LabsGoalSummary {
  id: string;
  title: string;
  description: string;
  runCount: number;
  lastRunAt: number;
  createdAt: number;
  keywords: string[];
  moderation: ModerationStatus;
  submitterWallet?: string;
  parentGoalId?: string;
  parentJobId?: string;
  parentCandidateIndex?: number;
  origin?: 'user' | 'branch';
}

/**
 * Per-goal job-context payload returned to the worker on a tick. The
 * planner injects this verbatim as a system message before the
 * user-prompt round so candidates build on accumulated work.
 */
export interface GoalContext {
  goal: LabsGoalSummary;
  /** Last N best candidates from prior runs of THIS goal. */
  priorCandidates: GoalContextCandidate[];
  /** Top related goals (by keyword overlap) and their best candidate. */
  relatedGoals: RelatedGoalContext[];
}

export interface GoalContextCandidate {
  /** Job id this candidate came from (for deep-linking only). */
  jobId: string;
  /** Job prompt — gives the planner the original framing. */
  jobPrompt: string;
  sequence: string;
  rationale: string;
  analysis?: string;
  score?: number;
  folded: boolean;
  at: number;
}

export interface RelatedGoalContext {
  goalId: string;
  title: string;
  overlapScore: number;
  topCandidate?: GoalContextCandidate;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'so', 'for',
  'of', 'on', 'in', 'at', 'by', 'to', 'with', 'from', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'shall',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'they',
  'my', 'our', 'your', 'their', 'his', 'her', 'them', 'us', 'me',
  'about', 'into', 'over', 'under', 'between', 'through', 'after', 'before',
  'how', 'why', 'what', 'when', 'where', 'which', 'who', 'whom',
  'cure', 'find', 'develop', 'study', 'research', 'investigate', 'explore',
  'using', 'use', 'used', 'via', 'using',
  'can', 'cannot', 'no', 'not', 'yes', 'all', 'any', 'some', 'more', 'less',
]);

/**
 * Extract a small set of lowercase keyword tokens from a free-text
 * prompt. Deterministic + cheap: alphabetic words ≥4 chars, stopwords
 * removed, deduped. We deliberately bias toward small-n; the keyword
 * index is for "find me other goals on the same medical topic", not
 * for full-text search.
 */
export function extractKeywords(text: string, max = 12): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  const unique = Array.from(new Set(tokens));
  return unique.slice(0, max);
}

/**
 * Score two keyword sets by Jaccard-style overlap, weighted toward
 * shared specific tokens. We don't need embeddings for v1 — exact
 * token match against the medical-jargon vocabulary is plenty.
 */
export function keywordOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of a) if (setB.has(t)) shared += 1;
  if (!shared) return 0;
  const union = new Set([...a, ...b]).size;
  return shared / union;
}

export const MAX_GOAL_TITLE = 120;
export const MAX_GOAL_DESCRIPTION = 800;
