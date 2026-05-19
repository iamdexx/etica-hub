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
 *   GROQ_API_KEY              — planning + analysis
 *   NVIDIA_API_KEY            — folding
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
  type ResearchPlan,
} from './steps/plan.js';
import { foldWithNvidia } from './steps/fold.js';
import { analyseStructure } from './steps/analyse.js';
import { mutateSequence } from './steps/mutate.js';

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
};

type JobResult = {
  plan: {
    hypothesis: string;
    approach: string;
    successCriteria: string;
    risks: string;
    references: Array<{
      source: 'pubmed' | 'pdb';
      id: string;
      title: string;
      detail: string;
      url: string;
    }>;
  };
  candidates: CandidateResult[];
  pdbBySequenceIndex: Record<number, string>;
  summary?: string;
};

const BASE_URL = (process.env.LABS_AUTOPILOT_BASE_URL ?? 'https://eticahub.com').replace(/\/$/, '');
const TOKEN = process.env.LABS_AUTOPILOT_TOKEN ?? '';
const MAX_JOBS_PER_TICK = Math.max(
  1,
  Math.min(5, Number(process.env.LABS_AUTOPILOT_MAX_JOBS_PER_TICK ?? '1')),
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
    const json = (await res.json()) as PriorContext;
    return json;
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
): Promise<CandidateResult> {
  log(`fold candidate[${index}] (${candidate.sequence.length} aa)`);
  const fold = await foldWithNvidia(candidate.sequence);
  if (!fold.ok) {
    events.push({
      kind: 'error',
      message: `Fold failed for candidate ${index}: ${fold.error}`,
      meta: { index, engine: 'nvidia-esmfold' },
    });
    return {
      index,
      sequence: candidate.sequence,
      rationale: candidate.rationale,
      engine: 'nvidia-esmfold',
      folded: false,
      error: fold.error,
    };
  }

  events.push({
    kind: 'folded',
    message: `Candidate ${index} folded on NVIDIA (${fold.pdb.length} bytes)`,
    meta: { index, engine: 'nvidia-esmfold', bytes: fold.pdb.length },
  });
  pdbMap[index] = fold.pdb;

  log(`analyse candidate[${index}]`);
  const analysis = await analyseStructure(candidate.sequence, fold.pdb).catch((err) => {
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

  return {
    index,
    sequence: candidate.sequence,
    rationale: candidate.rationale,
    engine: 'nvidia-esmfold',
    folded: true,
    analysis: analysis?.summary,
    score: analysis?.score,
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

  // Iteration 1 — plan + fold + analyse.
  let plan: ResearchPlan;
  try {
    plan = await generatePlan(job.prompt, priorContext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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

  for (let i = 0; i < plan.candidates.length; i++) {
    const candidate = plan.candidates[i]!;
    const result = await buildCandidateResult(job.id, i, candidate, events, pdbMap);
    allCandidates.push(result);
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
    log(`iteration ${iter} — mutating candidate[${bestIndex}]`);

    const mutants = mutateSequence(best.sequence, 3);
    for (const mutant of mutants) {
      const idx = allCandidates.length;
      const candidate: PlanCandidate = {
        sequence: mutant.sequence,
        rationale: `Mutated parent #${bestIndex} (${mutant.description})`,
      };
      events.push({
        kind: 'mutated',
        message: `Generated mutant #${idx} from parent #${bestIndex}: ${mutant.description}`,
        meta: { parent: bestIndex, child: idx },
      });
      const result = await buildCandidateResult(job.id, idx, candidate, events, pdbMap);
      allCandidates.push(result);
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

  log(`done job ${job.id} — ${allCandidates.length} candidates`);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('LABS_AUTOPILOT_TOKEN is required.');
    process.exit(1);
  }
  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is required.');
    process.exit(1);
  }
  if (!process.env.NVIDIA_API_KEY) {
    console.error('NVIDIA_API_KEY is required.');
    process.exit(1);
  }

  log(`tick start; base=${BASE_URL}, max-jobs-per-tick=${MAX_JOBS_PER_TICK}`);
  let processed = 0;
  for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
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
