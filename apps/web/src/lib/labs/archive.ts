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
  /**
   * Wallet that originated the research (goal submitter). Recorded so the
   * treasury crank can preserve discoverer provenance in `submitterOf`
   * when it force-mints an abandoned record. Undefined for auto-seeded
   * goals with no human submitter.
   */
  submitterWallet?: string;
  /**
   * Parent branch-goal id, mirrored from the goal record. Lets the crank
   * reconstruct the ancestor-cascade link (`parentBranchGoalId`) at
   * force-mint time. Empty/undefined == root research record.
   */
  parentGoalId?: string;
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
 * List archived research whose completion is older than `cutoffMs` and
 * which has not yet been marked minted — i.e. the abandoned records the
 * treasury crank should settle on chain.
 *
 * The archive index is a ZSET scored by `completedAt`, so the oldest
 * entries (lowest score) are exactly the ones most likely past their
 * window. We scan the oldest `scanLimit` ids ascending and keep those
 * under the cutoff that are still flagged unminted. On-chain
 * `branchClaimed` is the authoritative dedupe and is checked by the
 * caller; `minted` here is a cheap local pre-filter.
 */
export async function listExpiredUnminted(
  cutoffMs: number,
  scanLimit = 50,
): Promise<ArchivedResearch[]> {
  const store = labsStore();
  const ids = await store.zrange(ARCHIVE_INDEX, 0, Math.max(0, scanLimit - 1));
  const out: ArchivedResearch[] = [];
  for (const id of ids) {
    const raw = await store.get(ARCHIVE_KEY(id));
    if (!raw) continue;
    const entry = JSON.parse(raw) as ArchivedResearch;
    if (entry.minted) continue;
    if (entry.completedAt > cutoffMs) break; // ascending — nothing older follows
    out.push(entry);
  }
  return out;
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
 * Full-text search across all archived research fields.
 * Scores entries by keyword match density for relevance ranking.
 * Used by the worker's plan step and by the encyclopedia UI.
 *
 * Searches across: goalTitle, disease, hypothesis, approach, summary,
 * candidate rationales, candidate analyses, and references.
 */
export async function searchPriorArt(
  keywords: string[],
  limit = 5,
): Promise<ArchivedResearch[]> {
  const store = labsStore();
  const normalizedKw = keywords.map((k) => k.toLowerCase().trim()).filter((k) => k.length > 2);
  if (normalizedKw.length === 0) return [];

  // Phase 1: Direct disease index lookups (fast path)
  const results: Array<{ entry: ArchivedResearch; score: number }> = [];
  const seen = new Set<string>();

  for (const kw of normalizedKw) {
    const ids = await store.zrevrange(ARCHIVE_DISEASE(kw), 0, limit * 2);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const raw = await store.get(ARCHIVE_KEY(id));
      if (!raw) continue;
      const entry: ArchivedResearch = JSON.parse(raw);
      const score = computeRelevanceScore(entry, normalizedKw);
      results.push({ entry, score });
    }
  }

  // Phase 2: Scan recent entries for full-text keyword matching
  const scanLimit = Math.max(200, limit * 10);
  const allIds = await store.zrevrange(ARCHIVE_INDEX, 0, scanLimit - 1);
  for (const id of allIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const raw = await store.get(ARCHIVE_KEY(id));
    if (!raw) continue;
    const entry: ArchivedResearch = JSON.parse(raw);
    const score = computeRelevanceScore(entry, normalizedKw);
    if (score > 0) {
      results.push({ entry, score });
    }
  }

  // Sort by relevance score descending, then by recency
  results.sort((a, b) => b.score - a.score || b.entry.completedAt - a.entry.completedAt);

  return results.slice(0, limit).map((r) => r.entry);
}

/**
 * Compute relevance score for a research entry against keywords.
 * Higher score = more keyword matches in important fields.
 */
function computeRelevanceScore(entry: ArchivedResearch, keywords: string[]): number {
  // Build searchable text from all fields with weights
  const fields: Array<{ text: string; weight: number }> = [
    { text: entry.disease ?? '', weight: 5 },
    { text: entry.goalTitle ?? '', weight: 4 },
    { text: entry.hypothesis, weight: 3 },
    { text: entry.approach, weight: 2 },
    { text: entry.summary, weight: 2 },
    { text: entry.prompt, weight: 2 },
    { text: entry.bestCandidate.rationale, weight: 1 },
    { text: entry.bestCandidate.analysis ?? '', weight: 1 },
    { text: entry.references.join(' '), weight: 1 },
    ...entry.candidates.map((c) => ({ text: `${c.rationale} ${c.analysis ?? ''}`, weight: 0.5 })),
  ];

  let score = 0;
  for (const kw of keywords) {
    for (const field of fields) {
      const lower = field.text.toLowerCase();
      if (lower.includes(kw)) {
        score += field.weight;
        // Bonus for exact word boundary match
        if (lower.split(/\s+/).includes(kw)) {
          score += field.weight * 0.5;
        }
      }
    }
  }

  // Bonus for fold quality
  if (entry.bestCandidate.score && entry.bestCandidate.score > 0.7) {
    score *= 1.2;
  }

  return score;
}

/**
 * Advanced search with faceted filtering and sorting.
 * Powers the encyclopedia UI's search functionality.
 */
export interface ArchiveSearchOptions {
  /** Free-text query (searches all fields) */
  q?: string;
  /** Filter by disease/condition */
  disease?: string;
  /** Filter by goal ID */
  goalId?: string;
  /** Only show minted entries */
  mintedOnly?: boolean;
  /** Minimum best candidate score */
  minScore?: number;
  /** Sort field */
  sort?: 'relevance' | 'date' | 'score';
  /** Pagination */
  limit?: number;
  offset?: number;
}

export interface ArchiveSearchResult {
  results: ArchivedResearch[];
  total: number;
  facets: {
    diseases: Array<{ name: string; count: number }>;
    topScores: Array<{ id: string; score: number; disease?: string }>;
  };
}

export async function searchArchive(opts: ArchiveSearchOptions): Promise<ArchiveSearchResult> {
  const store = labsStore();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? (opts.q ? 'relevance' : 'date');

  // Determine which index to scan
  let candidateIds: string[];
  if (opts.disease) {
    candidateIds = await store.zrevrange(ARCHIVE_DISEASE(opts.disease), 0, 500);
  } else if (opts.goalId) {
    candidateIds = await store.zrevrange(ARCHIVE_GOAL(opts.goalId), 0, 500);
  } else {
    candidateIds = await store.zrevrange(ARCHIVE_INDEX, 0, 500);
  }

  // Parse keywords from free-text query
  const keywords = opts.q
    ? opts.q.toLowerCase().split(/[\s,;.]+/).filter((w) => w.length > 2)
    : [];

  // Load and filter entries
  const scored: Array<{ entry: ArchivedResearch; relevance: number }> = [];
  const diseaseCounts = new Map<string, number>();

  for (const id of candidateIds) {
    const raw = await store.get(ARCHIVE_KEY(id));
    if (!raw) continue;
    const entry: ArchivedResearch = JSON.parse(raw);

    // Apply filters
    if (opts.mintedOnly && !entry.minted) continue;
    if (opts.minScore && (entry.bestCandidate.score ?? 0) < opts.minScore) continue;

    // Compute relevance if searching
    const relevance = keywords.length > 0 ? computeRelevanceScore(entry, keywords) : 1;
    if (keywords.length > 0 && relevance === 0) continue;

    scored.push({ entry, relevance });

    // Track disease facets
    const d = entry.disease ?? 'Unknown';
    diseaseCounts.set(d, (diseaseCounts.get(d) ?? 0) + 1);
  }

  // Sort
  if (sort === 'relevance') {
    scored.sort((a, b) => b.relevance - a.relevance || b.entry.completedAt - a.entry.completedAt);
  } else if (sort === 'score') {
    scored.sort(
      (a, b) =>
        (b.entry.bestCandidate.score ?? 0) - (a.entry.bestCandidate.score ?? 0) ||
        b.entry.completedAt - a.entry.completedAt,
    );
  } else {
    scored.sort((a, b) => b.entry.completedAt - a.entry.completedAt);
  }

  const total = scored.length;
  const paged = scored.slice(offset, offset + limit).map((s) => s.entry);

  // Build facets
  const diseases = Array.from(diseaseCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const topScores = scored
    .slice(0, 10)
    .map((s) => ({
      id: s.entry.id,
      score: s.entry.bestCandidate.score ?? 0,
      disease: s.entry.disease,
    }));

  return { results: paged, total, facets: { diseases, topScores } };
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
