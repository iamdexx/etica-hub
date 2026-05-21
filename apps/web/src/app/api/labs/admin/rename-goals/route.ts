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

import { listGoals, updateGoal } from '@/lib/labs/goal-store';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

const CANDIDATE_PATTERN = /candidate\s*#?\d/i;
// Matches titles that are mostly uppercase amino acid sequences (≥12 consecutive uppercase letters)
const RAW_SEQUENCE_PATTERN = /[A-Z]{12,}/;

function needsRename(title: string): boolean {
  return CANDIDATE_PATTERN.test(title) || RAW_SEQUENCE_PATTERN.test(title);
}

async function generateTitle(description: string, oldTitle: string): Promise<string | null> {
  const keys = (
    process.env.GROQ_API_KEYS ??
    process.env.GROQ_API_KEY ??
    process.env.AIBOT_LLM_GROQ_API_KEY ??
    ''
  )
    .split(',')
    .filter(Boolean);
  if (!keys.length) return null;
  const key = keys[Math.floor(Math.random() * keys.length)];

  const prompt =
    `You are a scientific title generator for a public research feed. Given the description ` +
    `below, produce ONE concise title (max 80 chars) describing the RESEARCH ANGLE — ` +
    `e.g. "EGFR loop stabilization via salt-bridge engineering" or ` +
    `"pLDDT-guided helix refinement for anti-biofilm peptide".\n\n` +
    `STRICT RULES:\n` +
    `- NEVER include raw amino acid sequences (like MVIAEKMLQIL...) in the title\n` +
    `- NEVER start with a long uppercase string\n` +
    `- DO name the target protein, mutation type, or mechanism\n` +
    `- Keep it under 80 characters\n` +
    `- No quotes or explanations — just the title\n\n` +
    `Description: ${description.slice(0, 600)}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      console.error(`[rename-goals] Groq ${res.status}: ${await res.text().catch(() => '')}`);
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

export async function POST(req: NextRequest): Promise<Response> {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return json(auth.body, { status: auth.status });

  // Check Groq key availability before starting
  const hasKey = !!(
    process.env.GROQ_API_KEYS ??
    process.env.GROQ_API_KEY ??
    process.env.AIBOT_LLM_GROQ_API_KEY
  );
  if (!hasKey) {
    return json(
      {
        error:
          'No Groq API key available (checked GROQ_API_KEYS, GROQ_API_KEY, AIBOT_LLM_GROQ_API_KEY)',
      },
      { status: 503 },
    );
  }

  const allGoals = await listGoals(200, 0);
  const toRename = allGoals.filter((g) => g.origin === 'branch' && needsRename(g.title));

  if (!toRename.length) {
    return json({ renamed: [], skipped: allGoals.length, message: 'No goals need renaming.' });
  }

  const renamed: Array<{ id: string; oldTitle: string; newTitle: string }> = [];
  let skipped = 0;

  for (const goal of toRename) {
    const newTitle = await generateTitle(goal.description, goal.title);
    if (!newTitle) {
      skipped += 1;
      continue;
    }
    await updateGoal(goal.id, { title: newTitle });
    renamed.push({ id: goal.id, oldTitle: goal.title, newTitle });
    // Small delay to avoid Groq rate limits
    await new Promise((r) => setTimeout(r, 1200));
  }

  return json({ renamed, skipped, total: toRename.length });
}
