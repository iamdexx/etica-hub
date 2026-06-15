/**
 * Persistence layer for {@link LabsGoal} records and the keyword cross-
 * link index. Built on top of {@link labsStore} so the same Redis
 * deployment (Upstash REST / generic TCP / in-memory) backs goals
 * alongside the existing labs queue.
 *
 * Key layout:
 *   labs:goal:{id}               STRING  JSON-serialised LabsGoal
 *   labs:goal:index              ZSET    member=id, score=updatedAt
 *   labs:goal:kw:{keyword}       SET     of goal ids containing kw
 *   labs:goal:jobs:{goalId}      ZSET    member=jobId, score=createdAt
 */
import { randomUUID } from 'crypto';

import {
  type LabsGoal,
  type LabsGoalSummary,
  extractKeywords,
  keywordOverlap,
  MAX_GOAL_DESCRIPTION,
  MAX_GOAL_TITLE,
} from './goal';
import { labsStore } from './store';

const GOAL_KEY = (id: string) => `labs:goal:${id}`;
const GOAL_INDEX = 'labs:goal:index';
const GOAL_KW = (kw: string) => `labs:goal:kw:${kw}`;
const GOAL_JOBS = (id: string) => `labs:goal:jobs:${id}`;

/* ------------------------------------------------------------------ */
/*  Serialization                                                      */
/* ------------------------------------------------------------------ */

export function summariseGoal(g: LabsGoal): LabsGoalSummary {
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    runCount: g.runCount,
    lastRunAt: g.lastRunAt,
    createdAt: g.createdAt,
    keywords: g.keywords,
    moderation: g.moderation,
    submitterWallet: g.submitterWallet,
    parentGoalId: g.parentGoalId,
    parentJobId: g.parentJobId,
    parentCandidateIndex: g.parentCandidateIndex,
    origin: g.origin,
  };
}

function parseGoal(json: string | null): LabsGoal | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Partial<LabsGoal>;
    if (!obj || typeof obj.id !== 'string') return null;
    return {
      id: obj.id,
      title: typeof obj.title === 'string' ? obj.title : '',
      description: typeof obj.description === 'string' ? obj.description : '',
      keywords: Array.isArray(obj.keywords)
        ? obj.keywords.filter((k): k is string => typeof k === 'string')
        : [],
      createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
      runCount: typeof obj.runCount === 'number' ? obj.runCount : 0,
      lastRunAt: typeof obj.lastRunAt === 'number' ? obj.lastRunAt : 0,
      submitterTag: typeof obj.submitterTag === 'string' ? obj.submitterTag : 'anon',
      submitterWallet:
        typeof obj.submitterWallet === 'string' ? obj.submitterWallet : undefined,
      moderation: (obj.moderation as LabsGoal['moderation']) ?? 'visible',
      parentGoalId:
        typeof obj.parentGoalId === 'string' && obj.parentGoalId ? obj.parentGoalId : undefined,
      parentJobId:
        typeof obj.parentJobId === 'string' && obj.parentJobId ? obj.parentJobId : undefined,
      parentCandidateIndex:
        typeof obj.parentCandidateIndex === 'number' && Number.isFinite(obj.parentCandidateIndex)
          ? obj.parentCandidateIndex
          : undefined,
      origin:
        obj.origin === 'branch' || obj.origin === 'user' ? obj.origin : undefined,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  CRUD                                                               */
/* ------------------------------------------------------------------ */

export async function getGoal(id: string): Promise<LabsGoal | null> {
  if (!id) return null;
  const store = labsStore();
  return parseGoal(await store.get(GOAL_KEY(id)));
}

export async function listGoals(limit = 40, offset = 0): Promise<LabsGoal[]> {
  const store = labsStore();
  const ids = await store.zrevrange(GOAL_INDEX, offset, offset + limit - 1);
  if (!ids.length) return [];
  const goals = await Promise.all(ids.map((id) => getGoal(id)));
  return goals.filter((g): g is LabsGoal => !!g);
}

export interface CreateGoalInput {
  title: string;
  description: string;
  submitterTag: string;
  submitterWallet?: string;
  parentGoalId?: string;
  parentJobId?: string;
  parentCandidateIndex?: number;
  origin?: 'user' | 'branch';
}

export async function createGoal(input: CreateGoalInput): Promise<LabsGoal> {
  const now = Date.now();
  const id = randomUUID();
  const title = input.title.trim().slice(0, MAX_GOAL_TITLE) || 'Untitled goal';
  const description = input.description.trim().slice(0, MAX_GOAL_DESCRIPTION);
  const keywords = extractKeywords(`${title} ${description}`);
  const goal: LabsGoal = {
    id,
    title,
    description,
    keywords,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    lastRunAt: 0,
    submitterTag: input.submitterTag,
    submitterWallet: input.submitterWallet,
    moderation: 'visible',
    parentGoalId: input.parentGoalId,
    parentJobId: input.parentJobId,
    parentCandidateIndex: input.parentCandidateIndex,
    origin: input.origin ?? (input.parentGoalId ? 'branch' : 'user'),
  };
  await persistGoal(goal, { newKeywords: keywords, oldKeywords: [] });
  return goal;
}

export interface UpdateGoalPatch {
  title?: string;
  description?: string;
  runCountDelta?: number;
  lastRunAt?: number;
  moderation?: LabsGoal['moderation'];
}

export async function updateGoal(id: string, patch: UpdateGoalPatch): Promise<LabsGoal | null> {
  const existing = await getGoal(id);
  if (!existing) return null;
  const next: LabsGoal = {
    ...existing,
    updatedAt: Date.now(),
  };
  let reindex = false;
  if (typeof patch.title === 'string') {
    next.title = patch.title.trim().slice(0, MAX_GOAL_TITLE) || next.title;
    reindex = true;
  }
  if (typeof patch.description === 'string') {
    next.description = patch.description.trim().slice(0, MAX_GOAL_DESCRIPTION);
    reindex = true;
  }
  if (typeof patch.runCountDelta === 'number') {
    next.runCount = Math.max(0, next.runCount + patch.runCountDelta);
  }
  if (typeof patch.lastRunAt === 'number') {
    next.lastRunAt = patch.lastRunAt;
  }
  if (patch.moderation) {
    next.moderation = patch.moderation;
  }
  const oldKeywords = existing.keywords;
  if (reindex) {
    next.keywords = extractKeywords(`${next.title} ${next.description}`);
  }
  await persistGoal(next, {
    newKeywords: next.keywords,
    oldKeywords: reindex ? oldKeywords : next.keywords,
  });
  return next;
}

async function persistGoal(
  goal: LabsGoal,
  delta: { newKeywords: string[]; oldKeywords: string[] },
): Promise<void> {
  const store = labsStore();
  await store.set(GOAL_KEY(goal.id), JSON.stringify(goal));
  await store.zadd(GOAL_INDEX, goal.updatedAt, goal.id);
  const oldSet = new Set(delta.oldKeywords);
  const newSet = new Set(delta.newKeywords);
  for (const kw of oldSet) {
    if (!newSet.has(kw)) await store.srem(GOAL_KW(kw), goal.id);
  }
  for (const kw of newSet) {
    if (!oldSet.has(kw)) await store.sadd(GOAL_KW(kw), goal.id);
  }
}

/* ------------------------------------------------------------------ */
/*  Goal ↔ Job linking                                                 */
/* ------------------------------------------------------------------ */

export async function attachJobToGoal(goalId: string, jobId: string, at: number): Promise<void> {
  const store = labsStore();
  await store.zadd(GOAL_JOBS(goalId), at, jobId);
}

export async function listGoalJobIds(goalId: string, limit = 40): Promise<string[]> {
  const store = labsStore();
  return store.zrevrange(GOAL_JOBS(goalId), 0, limit - 1);
}

export async function countGoalJobs(goalId: string): Promise<number> {
  const store = labsStore();
  return store.zcard(GOAL_JOBS(goalId));
}

/* ------------------------------------------------------------------ */
/*  Cross-goal keyword search                                          */
/* ------------------------------------------------------------------ */

export async function relatedGoalIds(goal: LabsGoal, limit = 5): Promise<
  Array<{ id: string; overlap: number }>
> {
  if (!goal.keywords.length) return [];
  const store = labsStore();
  const tally = new Map<string, string[]>();
  for (const kw of goal.keywords) {
    const members = await store.smembers(GOAL_KW(kw));
    for (const id of members) {
      if (id === goal.id) continue;
      const arr = tally.get(id) ?? [];
      arr.push(kw);
      tally.set(id, arr);
    }
  }
  const scored: Array<{ id: string; overlap: number }> = [];
  for (const [id, sharedKws] of tally) {
    const other = await getGoal(id);
    if (!other || other.moderation === 'hidden' || other.moderation === 'operator-hidden') {
      continue;
    }
    scored.push({ id, overlap: keywordOverlap(goal.keywords, other.keywords) + sharedKws.length * 0.001 });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, limit);
}
