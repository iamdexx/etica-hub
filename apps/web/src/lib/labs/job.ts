/**
 * Shared types for the Labs Autopilot job pipeline.
 *
 * A job is created when a user submits a research goal via /labs (or
 * directly via POST /api/labs/queue). The GitHub Actions worker pops it
 * off Redis, runs the plan -> fold -> analyse -> mutate loop for up to
 * `iterations` rounds, and writes results back. The /labs/feed page
 * reads the same Redis to render the public lab notebook.
 */

import type { ModerationStatus } from './moderation';
import type { Reference } from './research';

export type LabsJobStatus =
  | 'pending' // queued, not yet picked up by a worker
  | 'running' // worker has it; still iterating
  | 'done' // all iterations finished cleanly
  | 'error'; // worker bailed; see events for details

export type LabsJobEventKind =
  | 'queued'
  | 'started'
  | 'planned'
  | 'folded'
  | 'fold_attempt_failed'
  | 'structure_pending'
  | 're_fold_requested'
  | 're_fold_completed'
  | 'analysed'
  | 'mutated'
  | 'proteinmpnn'
  | 'proteinmpnn_fallback'
  | 'docking_ready'
  | 'sequence_rejected'
  | 'sequence_low_quality'
  | 'iteration_done'
  | 'completed'
  | 'error'
  | 'note'
  | 'goal_context'
  | 'skipped';

export interface LabsJobEvent {
  at: number; // epoch ms
  kind: LabsJobEventKind;
  message: string;
  /** Optional extra payload; small JSON-safe map. */
  meta?: Record<string, string | number | boolean>;
}

export interface LabsCandidateResult {
  /** Index within the original plan candidates list. */
  index: number;
  sequence: string;
  /** Original rationale from the planner. */
  rationale: string;
  /** Engine that produced the PDB, e.g. 'nvidia-esmfold'. */
  engine?: string;
  /** Whether the fold attempt succeeded. */
  folded: boolean;
  /** Short structural analysis from Nvidia Nemotron (post-fold). */
  analysis?: string;
  /**
   * Optional numeric score in [0, 1] that the planner / scorer assigned
   * to this candidate. Worker may populate later iterations.
   */
  score?: number;
  /** Fold attempt error message, if `folded` is false. */
  error?: string;
  /**
   * True when the cascade failed and the candidate is awaiting structure.
   * Mint never blocks on fold: candidates can be published with a
   * sequence-only score and `pdb: null`; UI surfaces a "Structure pending"
   * badge with a re-fold action. Worker clears this on a successful retry.
   */
  structurePending?: boolean;
}

export interface LabsPlanSnapshot {
  hypothesis: string;
  approach: string;
  successCriteria: string;
  risks: string;
  references: Reference[];
}

export interface LabsJobResult {
  plan: LabsPlanSnapshot;
  candidates: LabsCandidateResult[];
  /** PDB bodies indexed by candidate.index; kept small (top-N only). */
  pdbBySequenceIndex: Record<number, string>;
  /** Optional summary string the worker writes at completion. */
  summary?: string;
}

export interface LabsJob {
  id: string;
  prompt: string;
  /** Iteration cap requested at submit time. Worker may stop earlier. */
  maxIterations: number;
  /** How many iteration rounds have been completed so far. */
  iterations: number;
  status: LabsJobStatus;
  createdAt: number;
  updatedAt: number;
  events: LabsJobEvent[];
  result?: LabsJobResult;
  /** Optional opaque submitter tag (truncated client IP hash or "anon"). */
  submitterTag?: string;
  /** Submitter EIP-191-signed wallet address (chain 61803), required on every new job. */
  submitterWallet?: string;
  /** Optional parent goal id — see lib/labs/goal.ts. */
  goalId?: string;
  /** Community moderation status. Defaults to 'visible' on legacy jobs. */
  moderation?: ModerationStatus;
  /**
   * How many times this job has been auto-requeued from `error` back to
   * `pending` by /api/labs/queue/requeue-errored. Bounded so a
   * persistently-failing job stops looping error -> pending forever
   * (which would burn the 40 RPM Nvidia budget every tick). Its data is
   * never removed — once the cap is hit the job simply stays in `error`.
   */
  requeueCount?: number;
}

/** Lightweight projection used by the public /labs/feed index. */
export interface LabsFeedEntry {
  id: string;
  prompt: string;
  status: LabsJobStatus;
  createdAt: number;
  updatedAt: number;
  iterations: number;
  goalId?: string;
  moderation?: ModerationStatus;
  /** Parent goal title — surfaced so feed cards can group by research topic. */
  goalTitle?: string;
  /** 'user' for top-level goals, 'branch' for child research chains. */
  goalOrigin?: 'user' | 'branch';
  /** Ancestor goal id when this goal was branched. */
  parentGoalId?: string;
  /** Ancestor goal title — surfaced so branches read as "Branch from <X>". */
  parentGoalTitle?: string;
  /** Root (top-level user-submitted) goal id — resolved by walking the full ancestor chain. */
  rootGoalId?: string;
  /** Root goal title — used as the topic chip label for grouping. */
  rootGoalTitle?: string;
}
