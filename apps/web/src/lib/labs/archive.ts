/**
 * Research Archive — permanent storage for completed Labs research.
 *
 * Unlike the job queue (7-day TTL), the archive persists ALL completed
 * research indefinitely. This enables:
 *
 *   1. Encyclopedia browsing — users can always find past work
 *   2. Prior-art injection — new research builds on old findings
 *   3. Cumulative metrics — lifetime totals never reset to zero
 *   4. NFT minting — completed research is always available to mint
 *
 * Key layout (Redis, no TTL):
 *   labs:archive:{id}              STRING  JSON-serialised ArchivedResearch
 *   labs:archive:index             ZSET    member=id, score=completedAt
 *   labs:archive:goal:{goalId}     ZSET    member=id, score=completedAt
 *   labs:archive:disease:{disease} ZSET    member=id, score=completedAt
 *   labs:archive:stats             STRING  JSON cumulative counters
 */

import { labsStore } from './store';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ArchivedCandidate {
  index: number;
  sequence: string;
  rationale: string;
  score?: number;
  analysis?: string;
  folded: boolean;
  engine?: string;
  dockingConfidence?: number;
}

export interface ArchivedResearch {
  id: string;
  jobId: string;
  goalId?: string;
  goalTitle?: string;
  disease?: string;
  prompt: string;
  completedAt: number;
  /** Research plan hypothesis */
  hypothesis: string;
  approach: string;
  successCriteria?: string;
  /** Best candidate from this run */
  bestCandidate: ArchivedCandidate;
  /** All candidates (for full data) */
  candidates: ArchivedCandidate[];
  /** Total iterations run */
  iterations: number;
  /** Summary text */
  summary: string;
  /** PDB data for best candidate (if available) */
  bestPdb?: string;
  /** Prior work references used in planning */
  references: string[];
  /** Whether this has been minted as an NFT */
  minted: boolean;
  mintTxHash?: string;
}

export interface ArchiveStats {
  totalResearch: number;
  totalProteins: number;
  totalFolds: number;
  totalDiseases: number;
  totalMinted: number;
  lastCompletedAt: number;
}

/* ------------------------------------------------------------------ */
/*  Keys                                                               */
/* ------------------------------------------------------------------ */

const ARCHIVE_KEY = (id: string) => `labs:archive:${id}`;
const ARCHIVE_INDEX = 'labs:archive:index';
const ARCHIVE_GOAL = (goalId: string) => `labs:archive:goal:${goalId}`;
const ARCHIVE_DISEASE = (disease: string) => `labs:archive:disease:${disease.toLowerCase()}`;
const ARCHIVE_STATS = 'labs:archive:stats';

/* ------------------------------------------------------------------ */
/*  Write                                                              */
/* ------------------------------------------------------------------ */

/**
 * Archive a completed research result permanently.
 * Called by the /api/labs/queue/[id]/update endpoint when a job
 * transitions to status=done.
 */
export async function archiveResearch(research: ArchivedResearch): Promise<void> {
  const store = labsStore();
  const key = ARCHIVE_KEY(research.id);

  // Store the full research data (no TTL — permanent)
  await store.set(key, JSON.stringify(research));

  // Index by completion time
  await store.zadd(ARCHIVE_INDEX, research.completedAt, research.id);

  // Index by goal
  if (research.goalId) {
    await store.zadd(ARCHIVE_GOAL(research.goalId), research.completedAt, research.id);
  }

  // Index by disease
  if (research.disease) {
    await store.zadd(ARCHIVE_DISEASE(research.disease), research.completedAt, research.id);
  }

  // Update cumulative stats
  await incrementStats(research);
}

async function incrementStats(research: ArchivedResearch): Promise<void> {
  const store = labsStore();
  const raw = await store.get(ARCHIVE_STATS);
  const stats: ArchiveStats = raw
    ? JSON.parse(raw)
    : {
        totalResearch: 0,
        totalProteins: 0,
        totalFolds: 0,
        totalDiseases: 0,
        totalMinted: 0,
        lastCompletedAt: 0,
      };

  stats.totalResearch += 1;
  stats.totalProteins += research.candidates.length;
  stats.totalFolds += research.candidates.filter((c) => c.folded).length;
  stats.lastCompletedAt = Math.max(stats.lastCompletedAt, research.completedAt);

  // Count unique diseases across archive
  if (research.disease) {
    const diseaseKey = ARCHIVE_DISEASE(research.disease);
    const count = await store.zcard(diseaseKey);
    if (count === 1) {
      // First entry for this disease
      stats.totalDiseases += 1;
    }
  }

  await store.set(ARCHIVE_STATS, JSON.stringify(stats));
}

/* ------------------------------------------------------------------ */
/*  Read                                                               */
/* ------------------------------------------------------------------ */

/**
 * Get a single archived research by ID.
 */
export async function getArchivedResearch(id: string): Promise<ArchivedResearch | null> {
  const store = labsStore();
  const raw = await store.get(ARCHIVE_KEY(id));
  return raw ? JSON.parse(raw) : null;
}

/**
 * List archived research, newest first.
 */
export async function listArchive(
  limit = 50,
  offset = 0,
): Promise<ArchivedResearch[]> {
  const store = labsStore();
  const ids = await store.zrevrange(ARCHIVE_INDEX, offset, offset + limit - 1);
  const results: ArchivedResearch[] = [];
  for (const id of ids) {
    const raw = await store.get(ARCHIVE_KEY(id));
    if (raw) results.push(JSON.parse(raw));
  }
  return results;
}

/**
 * List archived research for a specific goal.
 */
export async function listArchiveByGoal(
  goalId: string,
  limit = 50,
): Promise<ArchivedResearch[]> {
  const store = labsStore();
  const ids = await store.zrevrange(ARCHIVE_GOAL(goalId), 0, limit - 1);
  const results: ArchivedResearch[] = [];
  for (const id of ids) {
    const raw = await store.get(ARCHIVE_KEY(id));
    if (raw) results.push(JSON.parse(raw));
  }
  return results;
}

/**
 * List archived research for a specific disease.
 */
export async function listArchiveByDisease(
  disease: string,
  limit = 50,
): Promise<ArchivedResearch[]> {
  const store = labsStore();
  const ids = await store.zrevrange(ARCHIVE_DISEASE(disease), 0, limit - 1);
  const results: ArchivedResearch[] = [];
  for (const id of ids) {
    const raw = await store.get(ARCHIVE_KEY(id));
    if (raw) results.push(JSON.parse(raw));
  }
  return results;
}

/**
 * Get cumulative archive statistics (lifetime totals).
 */
export async function getArchiveStats(): Promise<ArchiveStats> {
  const store = labsStore();
  const raw = await store.get(ARCHIVE_STATS);
  return raw
    ? JSON.parse(raw)
    : {
        totalResearch: 0,
        totalProteins: 0,
        totalFolds: 0,
        totalDiseases: 0,
        totalMinted: 0,
        lastCompletedAt: 0,
      };
}

/**
 * Get total count of archived research entries.
 */
export async function getArchiveCount(): Promise<number> {
  const store = labsStore();
  return store.zcard(ARCHIVE_INDEX);
}

/**
 * Search archive for prior art related to a prompt.
 * Returns archived research with matching keywords from goal titles.
 * Used by the worker's plan step to inject prior context.
 */
export async function searchPriorArt(
  keywords: string[],
  limit = 5,
): Promise<ArchivedResearch[]> {
  const store = labsStore();
  // Search by disease keywords first
  const results: ArchivedResearch[] = [];
  const seen = new Set<string>();

  for (const kw of keywords) {
    if (results.length >= limit) break;
    const ids = await store.zrevrange(ARCHIVE_DISEASE(kw), 0, limit - 1);
    for (const id of ids) {
      if (seen.has(id) || results.length >= limit) continue;
      seen.add(id);
      const raw = await store.get(ARCHIVE_KEY(id));
      if (raw) results.push(JSON.parse(raw));
    }
  }

  // If we didn't find enough by disease, search the global index
  if (results.length < limit) {
    const allIds = await store.zrevrange(ARCHIVE_INDEX, 0, 100);
    for (const id of allIds) {
      if (seen.has(id) || results.length >= limit) continue;
      seen.add(id);
      const raw = await store.get(ARCHIVE_KEY(id));
      if (!raw) continue;
      const entry: ArchivedResearch = JSON.parse(raw);
      // Check if any keyword matches in title/hypothesis
      const text = `${entry.goalTitle ?? ''} ${entry.hypothesis} ${entry.disease ?? ''}`.toLowerCase();
      if (keywords.some((kw) => text.includes(kw.toLowerCase()))) {
        results.push(entry);
      }
    }
  }

  return results;
}

/**
 * Mark an archived research entry as minted.
 */
export async function markAsMinted(id: string, txHash: string): Promise<void> {
  const store = labsStore();
  const raw = await store.get(ARCHIVE_KEY(id));
  if (!raw) return;
  const research: ArchivedResearch = JSON.parse(raw);
  research.minted = true;
  research.mintTxHash = txHash;
  await store.set(ARCHIVE_KEY(id), JSON.stringify(research));

  // Update stats
  const statsRaw = await store.get(ARCHIVE_STATS);
  if (statsRaw) {
    const stats: ArchiveStats = JSON.parse(statsRaw);
    stats.totalMinted += 1;
    await store.set(ARCHIVE_STATS, JSON.stringify(stats));
  }
}

/**
 * Extract disease name from a goal title.
 * Expects format: "Disease — Research Specifics"
 */
export function extractDisease(title: string): string | undefined {
  const parts = title.split(/\s*[—–-]\s*/);
  if (parts.length >= 2 && parts[0]!.length > 2) {
    return parts[0]!.trim();
  }
  return undefined;
}
