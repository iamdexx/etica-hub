/**
 * Rewrite already-archived records so the public archive reads like a
 * reference work: internal seed labels ("Curated Fallback") and planner
 * narration ("Better: \"Engineer …", "Count chars: …") are replaced with
 * a `Condition — Research Specifics` title, the record is filed under the
 * condition its own text implies, and the goal behind it is renamed to
 * match.
 *
 * POST /api/labs/archive/editorial-backfill  { offset?, limit?, dryRun? }
 * Worker-token protected; deterministic (no model call), one page per
 * call, returns the next offset so the caller can walk the archive.
 *
 * Nothing is deleted and no scientific content is touched — only the
 * presentation metadata. A record whose prompt is pure narration keeps
 * its prompt and is reported under `unsalvageable` for review rather than
 * dressed up as a clean entry.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  getArchiveCount,
  listArchive,
  reindexDisease,
  saveArchivedResearch,
  type ArchivedResearch,
} from '@/lib/labs/archive';
import {
  canonicalDisease,
  cleanProse,
  cleanPrompt,
  editorialTitle,
  isPlumbingTitle,
  resolveDisease,
} from '@/lib/labs/editorial';
import { getGoal, updateGoal } from '@/lib/labs/goal-store';
import { requireWorkerAuth } from '@/lib/labs/worker-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEADLINE_MS = 50_000;

export async function POST(req: NextRequest) {
  const auth = requireWorkerAuth(req);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  let body: { offset?: unknown; limit?: unknown; dryRun?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
  const dryRun = body.dryRun === true;

  const total = await getArchiveCount();
  const page = await listArchive(limit, offset);

  const changes: Array<{
    id: string;
    oldTitle?: string;
    newTitle: string;
    oldDisease?: string;
    newDisease?: string;
    promptCleaned: boolean;
  }> = [];
  const unsalvageable: Array<{ id: string; prompt: string }> = [];
  const renamedGoals = new Set<string>();
  let processed = 0;
  let unchanged = 0;
  const deadline = Date.now() + DEADLINE_MS;

  for (const record of page) {
    if (Date.now() > deadline) break;
    processed += 1;

    const cleanedPrompt = cleanPrompt(record.prompt);
    if (!cleanedPrompt) unsalvageable.push({ id: record.id, prompt: record.prompt.slice(0, 200) });
    // A run whose prompt is pure narration is titled from what it actually
    // did — hypothesis and summary — rather than from the scratchpad.
    const basis = cleanedPrompt ?? '';
    const context = [record.hypothesis, record.approach, record.summary]
      .filter(Boolean)
      .join(' ')
      .slice(0, 600);

    const newTitle = editorialTitle(record.goalTitle, basis, context);
    const newDisease = canonicalDisease(resolveDisease(newTitle, `${basis} ${context}`));
    const promptCleaned = !!cleanedPrompt && cleanedPrompt !== record.prompt;
    const titleChanged = newTitle !== record.goalTitle;
    const diseaseChanged = newDisease !== record.disease;
    const hypothesis = cleanProse(record.hypothesis) ?? record.hypothesis;
    const approach = cleanProse(record.approach) ?? record.approach;
    const successCriteria = cleanProse(record.successCriteria) ?? record.successCriteria;
    const proseChanged =
      hypothesis !== record.hypothesis ||
      approach !== record.approach ||
      successCriteria !== record.successCriteria;

    if (!titleChanged && !diseaseChanged && !promptCleaned && !proseChanged) {
      unchanged += 1;
      continue;
    }

    changes.push({
      id: record.id,
      oldTitle: record.goalTitle,
      newTitle,
      oldDisease: record.disease,
      newDisease,
      promptCleaned,
    });
    if (dryRun) continue;

    const updated: ArchivedResearch = {
      ...record,
      goalTitle: newTitle,
      disease: newDisease,
      prompt: cleanedPrompt ?? record.prompt,
      hypothesis,
      approach,
      successCriteria,
    };
    await saveArchivedResearch(updated);
    if (diseaseChanged) await reindexDisease(updated, record.disease);

    // The goal is what the feed and the goal list render, so it has to
    // carry the same title as the record it produced.
    if (record.goalId && !renamedGoals.has(record.goalId)) {
      renamedGoals.add(record.goalId);
      try {
        const goal = await getGoal(record.goalId);
        if (goal && (isPlumbingTitle(goal.title) || goal.title !== newTitle)) {
          await updateGoal(goal.id, { title: newTitle });
        }
      } catch {
        /* non-fatal: the archive record is already corrected */
      }
    }
  }

  const nextOffset = offset + processed;
  return NextResponse.json({
    ok: true,
    dryRun,
    total,
    processed,
    unchanged,
    offset,
    nextOffset: nextOffset < total && processed > 0 ? nextOffset : null,
    changed: changes.length,
    changes: changes.slice(0, 25),
    unsalvageable,
  });
}
