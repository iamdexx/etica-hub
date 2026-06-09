/**
 * Auto-expansion helpers for EticaLabs Autopilot.
 *
 * When a goal-attached job completes, the worker calls
 * POST /api/labs/queue/spawn to enqueue a follow-up job that builds on
 * the prior result. This module enforces the safety bounds that keep
 * the loop from running away:
 *
 *   • Per-goal daily cap (default 6 follow-ups / goal / day) so a single
 *     goal can't burn through Nvidia quotas.
 *   • Global pending-queue cap (default 50) so a viral surge of new
 *     submissions can't fan out infinitely.
 *   • Operator pause: any goal with moderation === 'operator-hidden'
 *     stops accepting follow-ups until the operator (or community
 *     vouches) restore it. Community-hidden / denied goals are also
 *     skipped.
 *
 * The caps are intentionally generous defaults; tune via env:
 *   LABS_EXPAND_DAILY_CAP    — default 6
 *   LABS_EXPAND_PENDING_CAP  — default 50
 */

import { labsStore } from './store';

export const EXPAND_DAILY_CAP = (() => {
  const raw = Number(process.env.LABS_EXPAND_DAILY_CAP ?? '6');
  if (!Number.isFinite(raw) || raw <= 0) return 6;
  return Math.min(50, Math.max(1, Math.floor(raw)));
})();

export const EXPAND_PENDING_CAP = (() => {
  const raw = Number(process.env.LABS_EXPAND_PENDING_CAP ?? '50');
  if (!Number.isFinite(raw) || raw <= 0) return 50;
  return Math.min(500, Math.max(1, Math.floor(raw)));
})();

const DAILY_TTL_SECONDS = 25 * 60 * 60; // 25h so the bucket clears cleanly each UTC day

function todayBucket(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dailyKey(goalId: string, now = Date.now()): string {
  return `labs:goal:daily:${goalId}:${todayBucket(now)}`;
}

/** Best-effort current count of expansion follow-ups spawned for this goal today. */
export async function getDailyExpansionCount(goalId: string): Promise<number> {
  const store = labsStore();
  const raw = await store.get(dailyKey(goalId));
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Atomically increment the goal's daily-expansion counter. Returns the
 * new value so the caller can decide whether the cap was hit on this
 * very increment (and roll back, in theory — but we treat the counter
 * as best-effort and let the caller call `getDailyExpansionCount` first
 * to gate, avoiding race-y refunds).
 */
export async function incrDailyExpansionCount(goalId: string): Promise<number> {
  const store = labsStore();
  const key = dailyKey(goalId);
  const next = await store.incr(key);
  if (next === 1) {
    await store.expire(key, DAILY_TTL_SECONDS).catch(() => {
      // Non-fatal: store will still expire on next-day rollover via the
      // bucket key. We just lose the explicit TTL.
    });
  }
  return next;
}

export type ExpansionDenyReason =
  | 'daily-cap-reached'
  | 'pending-cap-reached'
  | 'goal-hidden'
  | 'goal-missing'
  | 'goal-denied';

export interface ExpansionDecision {
  allowed: boolean;
  reason?: ExpansionDenyReason;
  dailyCount?: number;
  pendingCount?: number;
}

interface GoalLike {
  moderation: 'visible' | 'hidden' | 'operator-hidden' | 'operator-approved' | 'denied';
}

/**
 * Pure-function gate: given a goal + current counters, decide whether
 * an expansion job may be enqueued right now. Callers should fetch the
 * latest counters with {@link getDailyExpansionCount} and
 * {@link labsQueue.pendingCount} immediately before invoking.
 */
export function evaluateExpansion(
  goal: GoalLike | null,
  dailyCount: number,
  pendingCount: number,
): ExpansionDecision {
  if (!goal) return { allowed: false, reason: 'goal-missing' };
  if (goal.moderation === 'denied') {
    return { allowed: false, reason: 'goal-denied' };
  }
  if (goal.moderation === 'hidden' || goal.moderation === 'operator-hidden') {
    return { allowed: false, reason: 'goal-hidden' };
  }
  if (pendingCount >= EXPAND_PENDING_CAP) {
    return { allowed: false, reason: 'pending-cap-reached', pendingCount };
  }
  if (dailyCount >= EXPAND_DAILY_CAP) {
    return { allowed: false, reason: 'daily-cap-reached', dailyCount };
  }
  return { allowed: true, dailyCount, pendingCount };
}
