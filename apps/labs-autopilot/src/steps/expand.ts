/**
 * Worker-side "next research direction" generator.
 *
 * After a goal-attached job finishes, the worker calls
 * {@link proposeNextDirection} with the goal title + the prompt that
 * just completed + a short summary of the best candidate. Nvidia returns
 * a single-sentence follow-up research prompt that the worker then
 * enqueues via POST /api/labs/queue/spawn.
 *
 * The output is intentionally short (≤ 280 chars) so it fits the
 * existing 400-char prompt cap and stays focused — open-ended "explore
 * the whole space" prompts are far worse plans than narrow next-step
 * questions.
 *
 * Failure mode: if Nvidia is unreachable or returns garbage, we return
 * `null` and the worker skips the spawn. Better to no-op than enqueue
 * a malformed follow-up.
 */

import { nvidiaChat, NVIDIA_MODEL_PRIMARY, NVIDIA_MODEL_FALLBACK, readNvidiaLLMKeyPool } from '../nvidia';

const MAX_PROMPT_CHARS = 280;
// Nemotron 550B emits ~12 tokens/s, so even a short JSON branch plan
// (~400 tokens) needs ~35s. The old 15s cap timed out every branch
// proposal, which is why high-scoring leads never spawned child goals.
const REQUEST_TIMEOUT_MS = 60_000;
const BRANCH_TIMEOUT_MS = 120_000;

export interface ExpansionInput {
  goalTitle: string;
  goalDescription?: string;
  previousPrompt: string;
  bestCandidateSummary?: string;
  bestCandidateScore?: number;
  kind: 'continuation' | 'cross-goal';
  relatedGoalTitle?: string;
}

function systemPrompt(kind: 'continuation' | 'cross-goal'): string {
  const base =
    'detailed thinking off\n' +
    'You are EticaLabs Autopilot, an autonomous biomedical research planner. ' +
    'Given a research goal and the most recent finding, you propose the single most ' +
    'promising next research direction in the same space. Output ONLY one short ' +
    'imperative sentence (max 280 chars) describing the next research prompt. ' +
    'No preamble, no markdown, no quotes. Stay strictly within biomedical, ' +
    'structural-biology, drug-discovery, or public-health research. ' +
    'PATENT SAFETY: Always propose NOVEL research directions. Never suggest replicating ' +
    'existing patented therapeutics or known drug sequences. Focus on novel mechanisms, ' +
    'unexplored targets, or original structural modifications that diverge from existing IP. ' +
    'IMPORTANT: Never reference internal identifiers like "Candidate #1" or ' +
    '"Peptide #2" — instead refer to the actual sequence, target, or mechanism ' +
    'by name. The prompt will appear on a public research feed.';
  if (kind === 'cross-goal') {
    return (
      base +
      ' This is a cross-goal seed: the next prompt should bridge the original ' +
      "finding into the related goal's problem area."
    );
  }
  return (
    base +
    ' This is a continuation: build directly on the finding to refine, validate, ' +
    'or extend it within the same goal.'
  );
}

function userPrompt(input: ExpansionInput): string {
  const lines: string[] = [];
  lines.push(`Goal: ${input.goalTitle.slice(0, 200)}`);
  if (input.goalDescription) {
    lines.push(`Goal description: ${input.goalDescription.slice(0, 280)}`);
  }
  if (input.kind === 'cross-goal' && input.relatedGoalTitle) {
    lines.push(`Related goal to bridge into: ${input.relatedGoalTitle.slice(0, 200)}`);
  }
  lines.push(`Previous prompt: ${input.previousPrompt.slice(0, 280)}`);
  if (typeof input.bestCandidateScore === 'number') {
    lines.push(`Best candidate score: ${input.bestCandidateScore.toFixed(3)}`);
  }
  if (input.bestCandidateSummary) {
    lines.push(`Best candidate summary: ${input.bestCandidateSummary.slice(0, 600)}`);
  }
  lines.push(
    'Now write the next research prompt (ONE imperative sentence, ≤ 280 chars, no quotes):',
  );
  return lines.join('\n');
}

function sanitize(raw: string): string | null {
  let s = raw.trim();
  // strip surrounding quotes / backticks / markdown
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  s = s.replace(/^\s*[-*•]\s*/, '');
  s = s.split('\n')[0]?.trim() ?? '';
  if (!s) return null;
  if (s.length > MAX_PROMPT_CHARS) s = s.slice(0, MAX_PROMPT_CHARS).trim();
  // very-short outputs are almost always model refusals or junk
  if (s.length < 20) return null;
  return s;
}

async function callNvidia(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const result = await nvidiaChat({
      models: [model],
      temperature: 0.5,
      max_tokens: maxTokens,
      timeoutMs,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return result.content || null;
  } catch {
    return null;
  }
}

/**
 * Generate the next research direction. Returns `null` on any failure
 * — the worker should treat null as "skip the expansion this round".
 */
export async function proposeNextDirection(input: ExpansionInput): Promise<string | null> {
  if (readNvidiaLLMKeyPool().length === 0) return null;
  const system = systemPrompt(input.kind);
  const user = userPrompt(input);

  const primary = await callNvidia(NVIDIA_MODEL_PRIMARY, system, user, 200);
  if (primary) {
    const cleaned = sanitize(primary);
    if (cleaned) return cleaned;
  }
  const fallback = await callNvidia(NVIDIA_MODEL_FALLBACK, system, user, 200);
  if (fallback) {
    const cleaned = sanitize(fallback);
    if (cleaned) return cleaned;
  }
  return null;
}

/* ----------------------------------------------------------------- *
 *  Branch-goal proposer                                              *
 * ----------------------------------------------------------------- *
 * When a parent goal's job lands a high-scoring candidate, the       *
 * worker forks a dedicated child goal to drill into that specific    *
 * lead. We ask Nvidia for THREE outputs: a goal title, a short       *
 * description, and a first-job research prompt — all narrowly scoped *
 * to the winning sequence.                                           *
 * ----------------------------------------------------------------- */

export interface BranchInput {
  parentGoalTitle: string;
  parentGoalDescription?: string;
  parentPrompt: string;
  candidateIndex: number;
  candidateSequence: string;
  candidateScore: number;
  candidateAnalysis?: string;
  candidateRationale?: string;
}

export interface BranchPlan {
  title: string;
  description: string;
  firstPrompt: string;
}

const MAX_BRANCH_TITLE = 140;
const MAX_BRANCH_DESCRIPTION = 800;

function branchSystemPrompt(): string {
  return (
    'detailed thinking off\n' +
    'You are EticaLabs Autopilot, an autonomous biomedical research planner. ' +
    'A parent research goal has produced a high-scoring candidate worth a ' +
    'dedicated follow-up thread. You will design that branch goal. Reply ' +
    'with STRICT JSON only (no markdown, no preamble) matching this schema: ' +
    '{"title": <string, ≤80 chars>, "description": <string, ≤800 chars>, ' +
    '"firstPrompt": <string, ≤280 chars>}. Stay strictly within biomedical, ' +
    'structural-biology, drug-discovery, or public-health research.\n\n' +
    'CRITICAL RULES for the title:\n' +
    '- The title appears on a PUBLIC research feed as a TOPIC CHIP. It MUST ' +
    'follow the format: "Disease/Condition — Research Specifics"\n' +
    '- MUST start with a specific disease, condition, or therapeutic area ' +
    '(e.g. cancer type, infection, metabolic disorder)\n' +
    '- Follow with " — " (em dash) then the specific research angle\n' +
    '- NEVER include raw amino acid sequences (e.g. MVIAEKMLQIL...)\n' +
    '- NEVER reference internal numbering like "Candidate #1" or "Peptide #2"\n' +
    "- If the disease isn't obvious, infer from the target " +
    '(EGFR → cancer, antimicrobial peptide → infectious disease, ' +
    'cell-penetrating peptide → drug delivery)\n' +
    '- Good examples:\n' +
    '  "Ovarian Cancer — EGFR Loop Peptide Binding Optimization"\n' +
    '  "Glioblastoma — Platinum Nanoparticle-Peptide Delivery"\n' +
    '  "Bacterial Biofilm Infections — Anti-Biofilm Peptide Refinement"\n' +
    '  "Breast Cancer — HER2-Targeting Cell-Penetrating Peptide"\n' +
    '  "Antimicrobial Resistance — Membrane-Disrupting AMP Design"\n' +
    '- BAD examples (do NOT produce these):\n' +
    '  "MVIAEKMLQILADAMEAFASALDMATFRP Loop Stabilization" (has raw sequence)\n' +
    '  "Optimize Candidate #3 Peptide" (has ordinal reference)\n' +
    '  "Loop Refinement" (too vague, no disease context)\n' +
    '  "EGFR Binding Optimization" (missing disease prefix)\n' +
    '- Keep under 80 characters. Be concise and topic-focused.\n\n' +
    'The firstPrompt must be ONE imperative sentence describing the next concrete ' +
    'research action (e.g. characterise binding affinity, profile off-targets, ' +
    'design delivery vector). Do NOT echo the parent goal verbatim — narrow ' +
    'into the specific candidate sequence and its biological context.'
  );
}

function branchUserPrompt(input: BranchInput): string {
  const lines: string[] = [];
  lines.push(`Parent goal: ${input.parentGoalTitle.slice(0, 200)}`);
  if (input.parentGoalDescription) {
    lines.push(`Parent description: ${input.parentGoalDescription.slice(0, 280)}`);
  }
  lines.push(`Parent prompt that surfaced this lead: ${input.parentPrompt.slice(0, 280)}`);
  lines.push(`Lead candidate (pLDDT score ${input.candidateScore.toFixed(3)}):`);
  lines.push(`Sequence: ${input.candidateSequence.slice(0, 400)}`);
  if (input.candidateRationale) {
    lines.push(`Rationale: ${input.candidateRationale.slice(0, 400)}`);
  }
  if (input.candidateAnalysis) {
    lines.push(`Structural analysis: ${input.candidateAnalysis.slice(0, 600)}`);
  }
  lines.push(
    'Reply with the JSON object now. Remember: the title must name the actual ' +
      'molecule/target/mechanism — never say "Candidate #N":',
  );
  return lines.join('\n');
}

function parseBranchPlan(raw: string): BranchPlan | null {
  if (!raw) return null;
  // Pull the first {...} block out of the response in case the model
  // wrapped it in prose despite instructions.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { title?: unknown; description?: unknown; firstPrompt?: unknown };
  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_BRANCH_TITLE) : '';
  const description =
    typeof obj.description === 'string'
      ? obj.description.trim().slice(0, MAX_BRANCH_DESCRIPTION)
      : '';
  const firstPrompt =
    typeof obj.firstPrompt === 'string'
      ? obj.firstPrompt
          .trim()
          .replace(/^["'`]+|["'`]+$/g, '')
          .slice(0, MAX_PROMPT_CHARS)
      : '';
  if (title.length < 8 || firstPrompt.length < 20) return null;
  return { title, description, firstPrompt };
}

/**
 * Generate the title + description + first-job prompt for a dedicated
 * branch goal off of a parent goal's high-scoring candidate. Returns
 * null on any failure — worker treats null as "skip branching".
 */
export async function proposeBranchPlan(input: BranchInput): Promise<BranchPlan | null> {
  if (readNvidiaLLMKeyPool().length === 0) return null;
  const system = branchSystemPrompt();
  const user = branchUserPrompt(input);

  const primary = await callNvidia(NVIDIA_MODEL_PRIMARY, system, user, 600, BRANCH_TIMEOUT_MS);
  if (primary) {
    const parsed = parseBranchPlan(primary);
    if (parsed) return parsed;
  }
  const fallback = await callNvidia(NVIDIA_MODEL_FALLBACK, system, user, 600, BRANCH_TIMEOUT_MS);
  if (fallback) {
    const parsed = parseBranchPlan(fallback);
    if (parsed) return parsed;
  }
  return null;
}
