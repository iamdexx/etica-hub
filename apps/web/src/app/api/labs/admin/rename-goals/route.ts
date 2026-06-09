/**
 * One-time admin endpoint: renames branch goals whose titles contain
 * vague internal references like "Candidate #N". Uses the goal's own
 * description to derive a meaningful scientific title via Groq.
 *
 * POST /api/labs/admin/rename-goals
 *   headers: { x-labs-worker-token: <LABS_AUTOPILOT_TOKEN> }
 *   returns: { renamed: { id, oldTitle, newTitle }[], skipped: number }
 */

import { NextRequest } from 'next/server';

import { getGoal, listGoals, updateGoal } from '@/lib/labs/goal-store';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

const CANDIDATE_PATTERN = /candidate\s*#?\d/i;
const RAW_SEQUENCE_PATTERN = /[A-Z]{12,}/;
// Titles must start with a disease/condition prefix like "Ovarian Cancer —"
const HAS_DISEASE_PREFIX = /^[A-Z][a-zA-Z\s\/'-]+\s[—–\-]+\s/;

function needsRename(title: string): boolean {
  if (CANDIDATE_PATTERN.test(title)) return true;
  if (RAW_SEQUENCE_PATTERN.test(title)) return true;
  // Rename if missing disease/condition prefix
  if (!HAS_DISEASE_PREFIX.test(title)) return true;
  return false;
}

async function generateTitle(
  description: string,
  oldTitle: string,
  parentTitle?: string,
  parentDescription?: string,
): Promise<string | null> {
  const keys = (
    process.env.NVIDIA_API_KEYS ??
    process.env.NVIDIA_API_KEY ??
    ''
  )
    .split(',')
    .filter(Boolean);
  if (!keys.length) return null;
  const key = keys[Math.floor(Math.random() * keys.length)];

  const contextBlock = parentTitle
    ? `\nParent research topic: ${parentTitle.slice(0, 200)}` +
      (parentDescription ? `\nParent description: ${parentDescription.slice(0, 300)}` : '')
    : '';

  const prompt =
    `You are a scientific title generator for a public research feed browsed by ` +
    `researchers and the general public.\n\n` +
    `FORMAT REQUIRED: "Disease/Condition — Research Specifics"\n\n` +
    `GOOD examples:\n` +
    `- "Ovarian Cancer — EGFR Loop Peptide Binding Optimization"\n` +
    `- "Glioblastoma — Platinum Nanoparticle-Peptide Delivery"\n` +
    `- "Type 2 Diabetes — GLP-1 Receptor Agonist Design"\n` +
    `- "Bacterial Biofilm Infections — Anti-Biofilm Peptide Refinement"\n` +
    `- "Breast Cancer — HER2-Targeting Cell-Penetrating Peptide"\n` +
    `- "Antimicrobial Resistance — Membrane-Disrupting AMP Design"\n\n` +
    `STRICT RULES:\n` +
    `- MUST start with a specific disease, condition, or therapeutic area\n` +
    `- Follow with " — " (em dash) then the research specifics\n` +
    `- NEVER include raw amino acid sequences\n` +
    `- NEVER use vague terms like "Candidate #N" or "Loop Refinement" alone\n` +
    `- If the disease isn't obvious from the description, infer from the peptide ` +
    `target (e.g. EGFR → cancer, antimicrobial peptide → infectious disease)\n` +
    `- Keep under 80 characters total\n` +
    `- Output ONLY the title, no quotes or explanation\n\n` +
    `Current title: ${oldTitle.slice(0, 120)}\n` +
    `Description: ${description.slice(0, 400)}` +
    contextBlock;

  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-ultra-550b-a55b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      console.error(`[rename-goals] Nvidia ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '');
    if (!text || text.length > 140) {
      console.error(`[rename-goals] bad LLM output: ${text?.slice(0, 50) ?? 'empty'}`);
      return null;
    }
    // Reject if LLM still produced a bad title
    if (CANDIDATE_PATTERN.test(text)) return null;
    if (RAW_SEQUENCE_PATTERN.test(text)) return null;
    return text;
  } catch (err) {
    console.error('[rename-goals] generateTitle error:', err);
    return null;
  }
}

/**
 * PATCH — rename a single goal by id.
 * Body: { goalId: string, title?: string }
 * If title is provided, use it directly. Otherwise generate one via LLM.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as {
    goalId?: string;
    title?: string;
  };
  if (!body.goalId) return json({ error: 'goalId required' }, { status: 400 });

  const goal = await getGoal(body.goalId);
  if (!goal) return json({ error: 'Goal not found' }, { status: 404 });

  let newTitle: string | undefined = body.title?.trim() || undefined;
  if (!newTitle) {
    const parent = goal.parentGoalId ? await getGoal(goal.parentGoalId) : null;
    newTitle =
      (await generateTitle(
        goal.description,
        goal.title,
        parent?.title ?? undefined,
        parent?.description ?? undefined,
      )) ?? undefined;
  }
  if (!newTitle) return json({ error: 'Could not generate title' }, { status: 422 });

  await updateGoal(goal.id, { title: newTitle });
  return json({ id: goal.id, oldTitle: goal.title, newTitle });
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  // Check Nvidia key availability before starting
  const hasKey = !!(
    process.env.NVIDIA_API_KEYS ??
    process.env.NVIDIA_API_KEY
  );
  if (!hasKey) {
    return json(
      {
        error:
          'No Nvidia API key available (checked NVIDIA_API_KEYS, NVIDIA_API_KEY)',
      },
      { status: 503 },
    );
  }

  const allGoals = await listGoals(200, 0);
  const toRename = allGoals.filter((g) => needsRename(g.title));

  if (!toRename.length) {
    return json({ renamed: [], skipped: allGoals.length, message: 'No goals need renaming.' });
  }

  const renamed: Array<{ id: string; oldTitle: string; newTitle: string }> = [];
  let skipped = 0;
  const startTime = Date.now();
  const MAX_RUNTIME_MS = 50_000; // bail before Vercel's 60s timeout

  // Batch-fetch parent goals for context
  const parentCache = new Map<string, { title: string; description: string }>();
  for (const goal of toRename) {
    if (goal.parentGoalId && !parentCache.has(goal.parentGoalId)) {
      const parent = await getGoal(goal.parentGoalId);
      if (parent)
        parentCache.set(goal.parentGoalId, {
          title: parent.title,
          description: parent.description,
        });
    }
  }

  for (const goal of toRename) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) break;
    const parent = goal.parentGoalId ? parentCache.get(goal.parentGoalId) : undefined;
    const newTitle = await generateTitle(
      goal.description,
      goal.title,
      parent?.title,
      parent?.description,
    );
    if (!newTitle) {
      skipped += 1;
      continue;
    }
    await updateGoal(goal.id, { title: newTitle });
    renamed.push({ id: goal.id, oldTitle: goal.title, newTitle });
    // Small delay to avoid Groq rate limits
    await new Promise((r) => setTimeout(r, 400));
  }

  return json({ renamed, skipped, total: toRename.length });
}
