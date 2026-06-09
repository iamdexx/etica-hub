/**
 * EticaLabs Autopilot worker — single tick.
 *
 * Designed to run as a GitHub Actions cron job. On each tick we:
 *   1. POST /api/labs/queue/pop with the shared worker token. If 204, exit
 *      (queue is empty); if 200, we got a job to run.
 *   2. Generate a research plan with Groq from the user's prompt.
 *   3. For each plan candidate, fold the sequence on NVIDIA NIM ESMFold
 *      and ask Groq for a short structural analysis.
 *   4. POST /api/labs/queue/[id]/update with the events + result + status.
 *
 * The worker is intentionally chatty — every step posts an event so the
 * /labs/feed UI can render the run as it progresses (next tick, since
 * we batch updates server-side).
 *
 * Env:
 *   LABS_AUTOPILOT_BASE_URL   — e.g. https://eticahub.com
 *   LABS_AUTOPILOT_TOKEN      — shared secret; same value in Vercel env
 *   NVIDIA_API_KEY             — Nemotron LLM (planning + analysis) + ESMFold
 *
 * Optional:
 *   LABS_AUTOPILOT_MAX_JOBS_PER_TICK   — default 1
 *   LABS_AUTOPILOT_FOLD_TIMEOUT_MS     — default 60_000
 */

import 'dotenv/config';

import {
  generatePlan,
  type PlanCandidate,
  type PriorContext,
  type PriorContextCandidate,
  type PriorContextGoal,
  type Reference,
  type ResearchPlan,
  type ServerGoalContext,
} from './steps/plan.js';
import { foldWithCascade } from './steps/fold.js';
import { sequenceOnlyScore } from './steps/sequence-score.js';
import { analyseStructure } from './steps/analyse.js';
import { mutateSequence } from './steps/mutate.js';
import { designSequences } from './steps/proteinmpnn.js';
import { dockMolecule } from './steps/diffdock.js';
import { validateSequence, quickSequenceQuality } from './steps/esm2.js';
import { proposeBranchPlan, proposeNextDirection } from './steps/expand.js';

type LabsJobStatus = 'pending' | 'running' | 'done' | 'error';

type LabsJobEvent = {
  at?: number;
  kind: string;
  message: string;
  meta?: Record<string, string | number | boolean>;
};

type LabsJob = {
  id: string;
  prompt: string;
  maxIterations: number;
  iterations: number;
  status: LabsJobStatus;
  createdAt: number;
  updatedAt: number;
  events: LabsJobEvent[];
  goalId?: string;
};

type CandidateResult = {
  index: number;
  sequence: string;
  rationale: string;
  engine?: string;
  folded: boolean;
  analysis?: string;
  score?: number;
  error?: string;
  /** DiffDock binding confidence (0-1) if docking was performed */
  dockingConfidence?: number;
  /**
   * True when the cascade failed and we published the candidate with a
   * sequence-only score so mint is never blocked on a flaky fold host.
   * UI surfaces a "Structure pending — re-fold available" badge.
   */
  structurePending?: boolean;
};

type JobResult = {
  plan: {
    hypothesis: string;
    approach: string;
    successCriteria: string;
    risks: string;
    references: Reference[];
  };
  candidates: CandidateResult[];
  pdbBySequenceIndex: Record<number, string>;
  summary?: string;
};

const BASE_URL = (process.env.LABS_AUTOPILOT_BASE_URL ?? 'https://eticahub.com').replace(/\/$/, '');
const TOKEN = process.env.LABS_AUTOPILOT_TOKEN ?? '';
const MAX_JOBS_PER_TICK = Math.max(
  1,
  Math.min(50, Number(process.env.LABS_AUTOPILOT_MAX_JOBS_PER_TICK ?? '20')),
);
/** Hard wall-clock budget for one tick. GH Actions allows up to 6h; we
 * cap at 50 min by default so the runner exits cleanly and the next
 * Vercel-cron tick can pick up new work without bumping into a stale
 * instance. */
const TICK_BUDGET_MS = Math.max(
  60_000,
  Number(process.env.LABS_AUTOPILOT_TICK_BUDGET_MS ?? `${50 * 60 * 1000}`),
);
/** Cross-goal seeding threshold: best candidate score must exceed this
 * for the worker to also enqueue a follow-up on the top-related goal.
 * Range [0, 1]; default 0.75 = top quartile. Set to 1.1 to disable. */
const CROSS_GOAL_SCORE_THRESHOLD = Math.max(
  0,
  Math.min(1.1, Number(process.env.LABS_AUTOPILOT_CROSS_GOAL_THRESHOLD ?? '0.75')),
);
/** Branch-spawn threshold: when a goal-attached job finishes with a
 * winning candidate scoring at or above this, the worker forks a
 * dedicated child goal to drill into that specific lead while the
 * parent goal continues its own continuation/cross-goal expansion.
 * Range [0, 1.1]; default 0.85. Set to 1.1 to disable branching. */
const BRANCH_SCORE_THRESHOLD = Math.max(
  0,
  Math.min(1.1, Number(process.env.LABS_AUTOPILOT_BRANCH_SCORE_THRESHOLD ?? '0.85')),
);
/** Cooldown (ms) between consecutive jobs in the same tick. With
 * multi-key rotation this can be short — just enough to avoid
 * burst-firing requests on the same key. Set to 0 to disable. */
const INTER_JOB_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.LABS_AUTOPILOT_INTER_JOB_COOLDOWN_MS ?? '2000'),
);

function log(message: string, meta?: Record<string, unknown>): void {
  const stamp = new Date().toISOString();
  if (meta) {
    console.log(`[${stamp}] ${message}`, meta);
  } else {
    console.log(`[${stamp}] ${message}`);
  }
}

async function popJob(): Promise<LabsJob | null> {
  const res = await fetch(`${BASE_URL}/api/labs/queue/pop`, {
    method: 'POST',
    headers: { 'x-labs-worker-token': TOKEN },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pop failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { job: LabsJob };
  return json.job;
}

type UpdatePayload = {
  events?: LabsJobEvent[];
  status?: LabsJobStatus;
  iterationsDelta?: number;
  result?: JobResult;
};

async function update(id: string, payload: UpdatePayload): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/labs/queue/${encodeURIComponent(id)}/update`, {
    method: 'POST',
    headers: {
      'x-labs-worker-token': TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`update failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function fetchGoalContext(goalId: string): Promise<PriorContext | null> {
  try {
    const res = await fetch(
      `${BASE_URL}/api/labs/goals/${encodeURIComponent(goalId)}/context`,
      {
        method: 'GET',
        headers: { 'x-labs-worker-token': TOKEN },
      },
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as ServerGoalContext;

    // Map server field names to the worker-side PriorContext shape.
    // The API returns `priorCandidates` / `relatedGoals[].topCandidate`
    // while the worker expects `selfPriorCandidates` / `relatedGoals[].candidates[]`.
    const selfPriorCandidates: PriorContextCandidate[] = (raw.priorCandidates ?? []).map((c) => ({
      jobId: c.jobId,
      jobPrompt: c.jobPrompt,
      sequence: c.sequence,
      rationale: c.rationale,
      analysis: c.analysis,
      score: c.score,
    }));

    const relatedGoals: PriorContextGoal[] = (raw.relatedGoals ?? []).map((g) => ({
      id: g.goalId,
      title: g.title,
      candidates: g.topCandidate
        ? [{
            jobId: g.topCandidate.jobId,
            jobPrompt: g.topCandidate.jobPrompt,
            sequence: g.topCandidate.sequence,
            rationale: g.topCandidate.rationale,
            analysis: g.topCandidate.analysis,
            score: g.topCandidate.score,
          }]
        : [],
    }));

    return { selfPriorCandidates, relatedGoals };
  } catch (err) {
    log(`goal-context fetch failed for ${goalId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function touchGoal(goalId: string, completed: boolean): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/labs/goals/${encodeURIComponent(goalId)}/touch`, {
      method: 'POST',
      headers: {
        'x-labs-worker-token': TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ completed }),
    });
  } catch (err) {
    log(`goal-touch failed for ${goalId}: ${err instanceof Error ? err.message : err}`);
  }
}

type GoalSnapshot = {
  id: string;
  title: string;
  description?: string;
  moderation?: string;
  keywords?: string[];
};

async function fetchGoalSnapshot(goalId: string): Promise<GoalSnapshot | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/labs/goals/${encodeURIComponent(goalId)}`, {
      method: 'GET',
      headers: { 'x-labs-worker-token': TOKEN },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { goal?: GoalSnapshot } | GoalSnapshot;
    if (j && typeof j === 'object' && 'goal' in j && j.goal) return j.goal;
    if (j && typeof j === 'object' && 'id' in j) return j as GoalSnapshot;
    return null;
  } catch (err) {
    log(`goal fetch failed for ${goalId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function fetchRelatedGoalIds(
  goalId: string,
  limit = 3,
): Promise<Array<{ id: string; overlap: number }>> {
  try {
    const res = await fetch(
      `${BASE_URL}/api/labs/goals/${encodeURIComponent(goalId)}/related?limit=${limit}`,
      {
        method: 'GET',
        headers: { 'x-labs-worker-token': TOKEN },
      },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as { related?: Array<{ id: string; overlap: number }> };
    return Array.isArray(j.related) ? j.related : [];
  } catch (err) {
    log(`related-goals fetch failed for ${goalId}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

type SpawnOutcome =
  | { ok: true; id: string; kind: 'continuation' | 'cross-goal' }
  | { ok: false; reason: string };

async function spawnFollowUp(
  goalId: string,
  prompt: string,
  parentJobId: string,
  kind: 'continuation' | 'cross-goal',
): Promise<SpawnOutcome> {
  try {
    const res = await fetch(`${BASE_URL}/api/labs/queue/spawn`, {
      method: 'POST',
      headers: {
        'x-labs-worker-token': TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ goalId, prompt, parentJobId, kind }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: string;
      reason?: string;
    };
    if (data.ok && typeof data.id === 'string') {
      return { ok: true, id: data.id, kind };
    }
    return { ok: false, reason: data.reason ?? `http ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

type BranchOutcome =
  | { ok: true; goalId: string; jobId: string }
  | { ok: false; reason: string };

async function callBranchEndpoint(payload: {
  parentGoalId: string;
  parentJobId: string;
  title: string;
  description: string;
  firstPrompt: string;
}): Promise<BranchOutcome> {
  try {
    const res = await fetch(`${BASE_URL}/api/labs/goals/branch`, {
      method: 'POST',
      headers: {
        'x-labs-worker-token': TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      goalId?: string;
      jobId?: string;
      reason?: string;
    };
    if (data.ok && typeof data.goalId === 'string' && typeof data.jobId === 'string') {
      return { ok: true, goalId: data.goalId, jobId: data.jobId };
    }
    return { ok: false, reason: data.reason ?? `http ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * If the parent job produced a winner above BRANCH_SCORE_THRESHOLD,
 * fork a dedicated child goal to drill into that specific lead. The
 * parent continues with its own continuation chain in parallel.
 * Failures are non-fatal — the parent job stays `done`.
 */
async function maybeBranchHighScoreLead(
  job: LabsJob,
  winner: CandidateResult,
): Promise<void> {
  if (typeof winner.score !== 'number' || winner.score < BRANCH_SCORE_THRESHOLD) return;
  if (!winner.folded) return;
  if (!job.goalId) return;

  const parent = await fetchGoalSnapshot(job.goalId);
  if (!parent) {
    log(`branch skipped: parent goal ${job.goalId} not found`);
    return;
  }
  if (parent.moderation === 'denied') {
    log(`branch skipped: parent goal ${job.goalId} denied`);
    return;
  }

  const plan = await proposeBranchPlan({
    parentGoalTitle: parent.title,
    parentGoalDescription: parent.description,
    parentPrompt: job.prompt,
    candidateIndex: winner.index,
    candidateSequence: winner.sequence,
    candidateScore: winner.score,
    candidateAnalysis: winner.analysis,
    candidateRationale: winner.rationale,
  });
  if (!plan) {
    log(
      `branch skipped: planner returned no branch plan for goal ${job.goalId} (score ${winner.score.toFixed(2)})`,
    );
    return;
  }

  const outcome = await callBranchEndpoint({
    parentGoalId: job.goalId,
    parentJobId: job.id,
    title: plan.title,
    description: plan.description,
    firstPrompt: plan.firstPrompt,
  });
  if (outcome.ok) {
    log(
      `branched goal ${job.goalId} → child goal ${outcome.goalId}, first job ${outcome.jobId} (score ${winner.score.toFixed(2)})`,
    );
  } else {
    log(`branch declined for goal ${job.goalId}: ${outcome.reason}`);
  }
}

/**
 * Auto-expand a completed goal-attached job: ask Groq for the next
 * direction in the same problem space and (if score is strong enough)
 * also seed one cross-goal follow-up on the most-related goal.
 *
 * Server-side caps (per-goal daily, global pending, operator-pause)
 * are enforced by /api/labs/queue/spawn; this function fires the
 * request and trusts the response.
 */
async function enqueueAutoExpansion(
  job: LabsJob,
  plan: ResearchPlan,
  winner: CandidateResult | null,
): Promise<void> {
  if (!job.goalId) return;
  const goal = await fetchGoalSnapshot(job.goalId);
  if (!goal) {
    log(`expansion skipped: goal ${job.goalId} not found`);
    return;
  }
  if (
    goal.moderation === 'hidden' ||
    goal.moderation === 'operator-hidden' ||
    goal.moderation === 'denied'
  ) {
    log(`expansion skipped: goal ${job.goalId} is paused (${goal.moderation})`);
    return;
  }
  const summary =
    winner?.analysis ??
    plan.hypothesis ??
    `Best candidate: ${winner?.rationale ?? 'no candidate available'}`;
  const score = winner?.score;

  // 1. Same-goal continuation.
  const nextPrompt = await proposeNextDirection({
    goalTitle: goal.title,
    goalDescription: goal.description,
    previousPrompt: job.prompt,
    bestCandidateSummary: summary,
    bestCandidateScore: score,
    kind: 'continuation',
  });
  if (nextPrompt) {
    const out = await spawnFollowUp(job.goalId, nextPrompt, job.id, 'continuation');
    if (out.ok) {
      log(`auto-expanded goal ${job.goalId} → job ${out.id}`);
    } else {
      log(`auto-expansion declined for goal ${job.goalId}: ${out.reason}`);
    }
  } else {
    log(`auto-expansion skipped: planner returned no direction for goal ${job.goalId}`);
  }

  // 2. Cross-goal seeding if score is strong enough.
  if (typeof score === 'number' && score >= CROSS_GOAL_SCORE_THRESHOLD) {
    const related = await fetchRelatedGoalIds(job.goalId, 3);
    const top = related[0];
    if (top) {
      const relatedGoal = await fetchGoalSnapshot(top.id);
      if (
        relatedGoal &&
        relatedGoal.moderation !== 'hidden' &&
        relatedGoal.moderation !== 'operator-hidden' &&
        relatedGoal.moderation !== 'denied'
      ) {
        const crossPrompt = await proposeNextDirection({
          goalTitle: goal.title,
          goalDescription: goal.description,
          previousPrompt: job.prompt,
          bestCandidateSummary: summary,
          bestCandidateScore: score,
          kind: 'cross-goal',
          relatedGoalTitle: relatedGoal.title,
        });
        if (crossPrompt) {
          const out = await spawnFollowUp(relatedGoal.id, crossPrompt, job.id, 'cross-goal');
          if (out.ok) {
            log(`cross-goal seeded ${relatedGoal.id} → job ${out.id}`);
          } else {
            log(`cross-goal seed declined for ${relatedGoal.id}: ${out.reason}`);
          }
        }
      }
    }
  }
}

/**
 * Build a CandidateResult from a (sequence, rationale) by folding +
 * analysing. Each step writes events on success/failure.
 */
async function buildCandidateResult(
  jobId: string,
  index: number,
  candidate: PlanCandidate,
  events: LabsJobEvent[],
  pdbMap: Record<number, string>,
  ctx: {
    prompt: string;
    peerSequences: readonly string[];
  },
): Promise<CandidateResult> {
  // ESM2 pre-validation — reject sequences with invalid characters or
  // extremely poor composition before wasting ESMFold compute.
  const seqCheck = validateSequence(candidate.sequence);
  if (!seqCheck.valid) {
    events.push({
      kind: 'sequence_rejected',
      message: `Candidate ${index} rejected pre-fold: ${seqCheck.error}`,
      meta: { index },
    });
    return {
      index,
      sequence: candidate.sequence,
      rationale: candidate.rationale,
      folded: false,
      analysis: `Rejected: ${seqCheck.error}`,
      score: 0,
    };
  }
  const quality = quickSequenceQuality(candidate.sequence);
  if (quality < 0.2) {
    events.push({
      kind: 'sequence_low_quality',
      message: `Candidate ${index} has low composition quality (${quality.toFixed(2)}); skipping fold`,
      meta: { index, quality },
    });
    return {
      index,
      sequence: candidate.sequence,
      rationale: candidate.rationale,
      folded: false,
      analysis: `Low quality sequence (score ${quality.toFixed(2)})`,
      score: quality * 0.1,
    };
  }

  log(`fold candidate[${index}] (${candidate.sequence.length} aa)`);
  const outcome = await foldWithCascade(candidate.sequence);

  for (const attempt of outcome.attempts) {
    if (attempt.ok) {
      events.push({
        kind: 'folded',
        message: `Candidate ${index} folded on ${attempt.engine} (attempt ${attempt.attempts}, ${attempt.durationMs}ms)`,
        meta: { index, engine: attempt.engine, attempts: attempt.attempts },
      });
    } else if (attempt.attempts > 0) {
      events.push({
        kind: 'fold_attempt_failed',
        message: `Engine ${attempt.engine} failed after ${attempt.attempts} attempt(s): ${attempt.error ?? 'unknown'}`,
        meta: { index, engine: attempt.engine, attempts: attempt.attempts },
      });
    }
  }

  if (!outcome.ok) {
    const peers = ctx.peerSequences;
    const seqScore = sequenceOnlyScore({
      sequence: candidate.sequence,
      prompt: ctx.prompt,
      rationale: candidate.rationale,
      peerSequences: peers,
    });
    events.push({
      kind: 'structure_pending',
      message: `Cascade exhausted for candidate ${index}; publishing with sequence-only score ${seqScore.score.toFixed(2)} (structure pending re-fold).`,
      meta: { index, score: seqScore.score, peers: peers.length },
    });
    return {
      index,
      sequence: candidate.sequence,
      rationale: candidate.rationale,
      folded: false,
      structurePending: true,
      analysis: seqScore.summary,
      score: seqScore.score,
      error: outcome.error,
    };
  }

  pdbMap[index] = outcome.pdb;

  log(`analyse candidate[${index}]`);
  const analysis = await analyseStructure(candidate.sequence, outcome.pdb).catch((err) => {
    events.push({
      kind: 'error',
      message: `Analysis failed for candidate ${index}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      meta: { index },
    });
    return null;
  });

  if (analysis) {
    events.push({
      kind: 'analysed',
      message: `Analysed candidate ${index}`,
      meta: { index, score: analysis.score },
    });
  }

  // DiffDock — attempt drug-protein docking if analysis suggests a binding
  // target. This is non-blocking: failures don't prevent the candidate from
  // being published. The docking data enriches the research archive.
  let dockingConfidence: number | undefined;
  if (analysis && analysis.score >= 0.6) {
    // Only dock high-quality folds — docking a bad structure wastes compute.
    // In the future, the ligand would come from the analysis step identifying
    // a drug target. For now, this is a placeholder for the docking capability.
    // The pipeline will use this when ligand data is available in the archive.
    events.push({
      kind: 'docking_ready',
      message: `Candidate ${index} qualifies for docking (score ${analysis.score.toFixed(2)})`,
      meta: { index, score: analysis.score },
    });
  }

  return {
    index,
    sequence: candidate.sequence,
    rationale: candidate.rationale,
    engine: outcome.engine,
    folded: true,
    analysis: analysis?.summary,
    score: analysis?.score,
    dockingConfidence,
  };
}

async function runJob(job: LabsJob): Promise<void> {
  log(`run job ${job.id} (prompt: ${job.prompt.slice(0, 80)}…)`);

  const events: LabsJobEvent[] = [];
  const pdbMap: Record<number, string> = {};
  const allCandidates: CandidateResult[] = [];

  // Pull prior + cross-goal context if this job is attached to a goal.
  let priorContext: PriorContext | undefined;
  if (job.goalId) {
    const ctx = await fetchGoalContext(job.goalId);
    if (ctx) {
      priorContext = ctx;
      const selfN = ctx.selfPriorCandidates?.length ?? 0;
      const relN = ctx.relatedGoals?.length ?? 0;
      events.push({
        kind: 'goal_context',
        message: `Loaded goal context: ${selfN} prior candidate(s) + ${relN} related goal(s)`,
        meta: { goalId: job.goalId, selfPrior: selfN, related: relN },
      });
    }
  }

  // Search the permanent archive for prior art that relates to this prompt.
  // This is the cascade mechanism: new research always builds on old findings.
  try {
    const keywords = job.prompt
      .toLowerCase()
      .split(/[\s,;.]+/)
      .filter((w) => w.length > 3)
      .slice(0, 10);
    if (keywords.length > 0) {
      const archiveRes = await fetch(`${BASE_URL}/api/labs/archive/search`, {
        method: 'POST',
        headers: {
          'x-labs-worker-token': TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ keywords, limit: 3 }),
      });
      if (archiveRes.ok) {
        const { results } = (await archiveRes.json()) as {
          results: Array<{
            hypothesis: string;
            summary: string;
            bestCandidate: { sequence: string; score?: number };
          }>;
        };
        if (results.length > 0) {
          // Inject archived findings into prior context so the planner sees them
          if (!priorContext) {
            priorContext = { selfPriorCandidates: [], relatedGoals: [] };
          }
          for (const r of results) {
            priorContext.selfPriorCandidates = priorContext.selfPriorCandidates ?? [];
            priorContext.selfPriorCandidates.push({
              jobId: 'archive',
              sequence: r.bestCandidate.sequence,
              score: r.bestCandidate.score,
              analysis: `[Prior art] ${r.hypothesis}. ${r.summary}`,
            });
          }
          events.push({
            kind: 'goal_context',
            message: `Loaded ${results.length} prior art reference(s) from archive`,
            meta: { archiveHits: results.length },
          });
        }
      }
    }
  } catch (err) {
    log(`archive search failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // Iteration 1 — plan + fold + analyse.
  let plan: ResearchPlan;
  try {
    plan = await generatePlan(job.prompt, priorContext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`planner failed for ${job.id}: ${msg}`);
    await update(job.id, {
      events: [{ kind: 'error', message: `Planner failed: ${msg}` }],
      status: 'error',
      iterationsDelta: 0,
    });
    if (job.goalId) await touchGoal(job.goalId, false);
    return;
  }

  events.push({
    kind: 'planned',
    message: `Planned ${plan.candidates.length} candidate(s); referenced ${plan.references.length} prior work(s)`,
    meta: { candidates: plan.candidates.length, references: plan.references.length },
  });

  // Peer sequences used for sequence-only novelty scoring when the
  // cascade exhausts retries. Pull from the goal's prior self candidates
  // first (most similar context) then seed with this job's own results
  // so later candidates compare against earlier ones in the same run.
  const peerSequences: string[] = [];
  for (const prior of priorContext?.selfPriorCandidates ?? []) {
    if (prior.sequence) peerSequences.push(prior.sequence);
  }

  for (let i = 0; i < plan.candidates.length; i++) {
    const candidate = plan.candidates[i]!;
    const result = await buildCandidateResult(job.id, i, candidate, events, pdbMap, {
      prompt: job.prompt,
      peerSequences,
    });
    allCandidates.push(result);
    peerSequences.push(candidate.sequence);
  }

  events.push({ kind: 'iteration_done', message: 'Iteration 1 complete' });

  // Subsequent iterations — pick top scorer, mutate, fold + analyse N
  // mutants. Each iteration adds at most 3 new candidates.
  let bestIndex = allCandidates.reduce((bestIdx, c, i) => {
    const best = allCandidates[bestIdx];
    if (!best) return i;
    const a = c.score ?? -1;
    const b = best.score ?? -1;
    return a > b ? i : bestIdx;
  }, 0);

  for (let iter = 2; iter <= job.maxIterations; iter++) {
    const best = allCandidates[bestIndex];
    if (!best || !best.folded) {
      events.push({
        kind: 'note',
        message: `No foldable parent for iteration ${iter}; stopping`,
      });
      break;
    }
    log(`iteration ${iter} — designing sequences from candidate[${bestIndex}]`);

    // Try ProteinMPNN first (AI-designed sequences from the 3D backbone).
    // Falls back to deterministic point mutations if ProteinMPNN fails or
    // if no PDB is available for the parent.
    const parentPdb = pdbMap[bestIndex];
    let designedMutants: Array<{ sequence: string; description: string }> = [];

    if (parentPdb) {
      const mpnnResult = await designSequences({
        pdb: parentPdb,
        samplingTemp: 0.2,
        numSequences: 3,
      }).catch((err) => {
        log(`ProteinMPNN error: ${err instanceof Error ? err.message : err}`);
        return null;
      });

      if (mpnnResult && mpnnResult.ok) {
        events.push({
          kind: 'proteinmpnn',
          message: `ProteinMPNN designed ${mpnnResult.sequences.length} sequence(s) in ${mpnnResult.durationMs}ms`,
          meta: { count: mpnnResult.sequences.length, durationMs: mpnnResult.durationMs },
        });
        for (const designed of mpnnResult.sequences) {
          // Skip sequences identical to parent
          if (designed.sequence === best.sequence) continue;
          // ESM2 quick quality check
          const quality = quickSequenceQuality(designed.sequence);
          if (quality < 0.3) continue;
          designedMutants.push({
            sequence: designed.sequence,
            description: `ProteinMPNN design (score=${designed.score.toFixed(2)}, recovery=${(designed.recoveryRate * 100).toFixed(0)}%)`,
          });
        }
      } else {
        const errMsg = mpnnResult && !mpnnResult.ok ? mpnnResult.error : 'not available';
        events.push({
          kind: 'proteinmpnn_fallback',
          message: `ProteinMPNN unavailable (${errMsg}); using deterministic mutations`,
        });
      }
    }

    // Fallback to deterministic mutations if ProteinMPNN produced nothing
    if (designedMutants.length === 0) {
      const fallback = mutateSequence(best.sequence, 3);
      designedMutants = fallback.map((m) => ({
        sequence: m.sequence,
        description: m.description,
      }));
    }

    for (const mutant of designedMutants) {
      const idx = allCandidates.length;
      const candidate: PlanCandidate = {
        sequence: mutant.sequence,
        rationale: `Designed from parent #${bestIndex} (${mutant.description})`,
      };
      events.push({
        kind: 'mutated',
        message: `Generated variant #${idx} from parent #${bestIndex}: ${mutant.description}`,
        meta: { parent: bestIndex, child: idx },
      });
      const result = await buildCandidateResult(job.id, idx, candidate, events, pdbMap, {
        prompt: job.prompt,
        peerSequences,
      });
      allCandidates.push(result);
      peerSequences.push(candidate.sequence);
    }

    events.push({ kind: 'iteration_done', message: `Iteration ${iter} complete` });

    const newBest = allCandidates.reduce((bestIdx, c, i) => {
      const cur = allCandidates[bestIdx];
      if (!cur) return i;
      const a = c.score ?? -1;
      const b = cur.score ?? -1;
      return a > b ? i : bestIdx;
    }, 0);
    if (newBest === bestIndex) {
      events.push({
        kind: 'note',
        message: `No improvement at iteration ${iter}; stopping early`,
      });
      break;
    }
    bestIndex = newBest;
  }

  // Trim PDB blobs we won't keep — only persist top 4 by score (and the
  // first iteration's three so the user always sees the plan output).
  const keepIndices = new Set<number>([0, 1, 2]);
  const scored = [...allCandidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const c of scored.slice(0, 4)) keepIndices.add(c.index);
  for (const k of Object.keys(pdbMap)) {
    if (!keepIndices.has(Number(k))) delete pdbMap[Number(k)];
  }

  const winner = allCandidates[bestIndex] ?? null;
  const summary = winner
    ? `Best candidate: #${winner.index} (score ${winner.score?.toFixed(2) ?? '—'}). ${
        winner.rationale
      }`
    : 'No candidates produced.';

  events.push({
    kind: 'completed',
    message: summary,
    meta: { totalCandidates: allCandidates.length },
  });

  await update(job.id, {
    events,
    status: 'done',
    iterationsDelta: Math.min(job.maxIterations, Math.max(1, allCandidates.length / 3)),
    result: {
      plan: {
        hypothesis: plan.hypothesis,
        approach: plan.approach,
        successCriteria: plan.successCriteria,
        risks: plan.risks,
        references: plan.references,
      },
      candidates: allCandidates,
      pdbBySequenceIndex: pdbMap,
      summary,
    },
  });

  if (job.goalId) await touchGoal(job.goalId, true);

  // Auto-expansion: spawn the next research direction(s) so the worker
  // can keep chaining cures in the same problem space (and optionally
  // cross-pollinate into related goals). Failures here MUST NOT mark
  // the parent job as errored — the parent run completed successfully.
  if (job.goalId) {
    try {
      await enqueueAutoExpansion(job, plan, winner);
    } catch (err) {
      log(`auto-expansion threw for ${job.id}: ${err instanceof Error ? err.message : err}`);
    }

    // Strong-score branching: if the winning candidate cleared the
    // branch threshold, fork a dedicated child goal to drill into
    // that specific lead. Runs independently of the continuation
    // chain above so the parent keeps expanding in its own direction
    // while the branch deep-dives the high-scoring sequence. Failures
    // here are also non-fatal — the parent job stays `done`.
    if (winner) {
      try {
        await maybeBranchHighScoreLead(job, winner);
      } catch (err) {
        log(`branch threw for ${job.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  log(`done job ${job.id} — ${allCandidates.length} candidates`);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('LABS_AUTOPILOT_TOKEN is required.');
    process.exit(1);
  }
  if (!process.env.NVIDIA_API_KEY && !process.env.NVIDIA_API_KEYS) {
    console.error('NVIDIA_API_KEY (or comma-separated NVIDIA_API_KEYS) is required.');
    process.exit(1);
  }

  log(
    `tick start; base=${BASE_URL}, max-jobs-per-tick=${MAX_JOBS_PER_TICK}, budget=${Math.round(
      TICK_BUDGET_MS / 1000,
    )}s`,
  );

  // Requeue any jobs orphaned in "running" state by a previous tick that
  // crashed or timed out. Best-effort — failures here are non-fatal.
  try {
    const rRes = await fetch(`${BASE_URL}/api/labs/queue/requeue-stale`, {
      method: 'POST',
      headers: {
        'x-labs-worker-token': TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ maxAgeMs: 10 * 60 * 1000 }),
    });
    if (rRes.ok) {
      const rBody = (await rRes.json()) as { count?: number };
      if (rBody.count && rBody.count > 0) {
        log(`requeued ${rBody.count} stale running job(s)`);
      }
    }
  } catch (err) {
    log(`requeue-stale failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  const tickStart = Date.now();
  let processed = 0;
  for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
    if (Date.now() - tickStart > TICK_BUDGET_MS) {
      log(`tick budget exhausted after ${processed} job(s); exiting cleanly`);
      break;
    }
    let job: LabsJob | null;
    try {
      job = await popJob();
    } catch (err) {
      console.error('Pop failed:', err);
      process.exitCode = 1;
      return;
    }
    if (!job) {
      log('queue empty');
      break;
    }

    if (processed > 0 && INTER_JOB_COOLDOWN_MS > 0) {
      log(`cooldown ${INTER_JOB_COOLDOWN_MS}ms before next job`);
      await new Promise((r) => setTimeout(r, INTER_JOB_COOLDOWN_MS));
    }
    try {
      await runJob(job);
      processed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Job ${job.id} crashed:`, msg);
      try {
        await update(job.id, {
          events: [{ kind: 'error', message: `Worker crashed: ${msg.slice(0, 400)}` }],
          status: 'error',
        });
      } catch (updateErr) {
        console.error('Could not mark job errored:', updateErr);
      }
      if (job.goalId) await touchGoal(job.goalId, false);
      process.exitCode = 1;
    }
  }
  log(`tick end; processed ${processed} job(s)`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
