/**
 * Moderation primitives for EticaLabs submissions (jobs + goals).
 *
 * Four layers, executed in this order at submit time:
 *
 *   1. {@link runHardDenylist} — sync, regex-based, illegal-content floor
 *      (CSAM, WMD synthesis, targeted violence). Hard reject; never
 *      revertable, even by the operator.
 *   2. {@link runBiomedicalGate} — Groq topic classifier; rejects
 *      non-biomedical submissions. Fail-closed if Groq is unreachable.
 *   3. Worker-side prompt hardening — see `apps/labs-autopilot`. Plan/
 *      analyse/mutate prompts refuse to drift off-scope.
 *   4. Community moderation — flag/vouch counters drive auto-hide /
 *      auto-restore. Operator has final-veto via sticky overrides
 *      (`operator-hidden` / `operator-approved`).
 */

import { groqChat, GroqError } from './groq';

/* ------------------------------------------------------------------ */
/*  Status                                                             */
/* ------------------------------------------------------------------ */

export type ModerationStatus =
  /** Default state. Visible on feeds; worker may process. */
  | 'visible'
  /** Community auto-hid this item (flagCount >= threshold). */
  | 'hidden'
  /** Operator override: forced hidden. Sticky; community cannot restore. */
  | 'operator-hidden'
  /** Operator override: forced visible. Sticky; community auto-hide is bypassed. */
  | 'operator-approved'
  /** Layer 1 hard-denylist rejection. Permanent; never restorable. */
  | 'denied';

export const COMMUNITY_HIDE_THRESHOLD = 3;
export const COMMUNITY_RESTORE_DELTA = 5; // vouches > flags + this

/** Distinct moderation event kinds for the public audit log. */
export type ModerationEventKind =
  | 'flag'
  | 'vouch'
  | 'community-hidden'
  | 'community-restored'
  | 'community-overrode-operator'
  | 'operator-hidden'
  | 'operator-approved'
  | 'operator-restored'
  | 'denied';

export interface ModerationEvent {
  at: number;
  kind: ModerationEventKind;
  /** 'job' | 'goal' — what the action targeted. */
  targetType: 'job' | 'goal';
  targetId: string;
  /** Anonymised actor: IP-hash (community) or 'operator'. */
  actor: string;
  /** Optional human-readable reason (flag reasons + free-text). */
  reason?: string;
  /** Optional flag/vouch counts at time of event. */
  flagCount?: number;
  vouchCount?: number;
}

export interface ModerationCounts {
  flagCount: number;
  vouchCount: number;
  /** Whether the current actor has already voted (any direction). */
  actorVoted?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Flag reasons                                                       */
/* ------------------------------------------------------------------ */

export const FLAG_REASONS = [
  'off-topic',
  'low-quality',
  'safety-concern',
  'duplicate',
  'other',
] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export function isValidFlagReason(v: unknown): v is FlagReason {
  return typeof v === 'string' && (FLAG_REASONS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ */
/*  Layer 1: hard denylist                                             */
/* ------------------------------------------------------------------ */

/**
 * Patterns that must NEVER reach the queue, regardless of community
 * sentiment or operator override. Kept deliberately narrow so we don't
 * over-block legitimate medical research (e.g. discussing pathogens for
 * vaccine development is allowed; instructions to synthesise weaponised
 * variants is not).
 *
 * Patterns are case-insensitive, normalised against lowercased+spaced
 * input. New patterns require code review.
 */
const HARD_DENY_PATTERNS: { pattern: RegExp; category: string }[] = [
  // Child sexual abuse material — absolute floor
  { pattern: /\b(child|minor|underage|teen|kid|preteen|infant|baby)s?\b[^.]*\b(sex|sexual|porn|nude|naked|erotic|fetish|grooming)/i, category: 'csam' },
  { pattern: /\b(sex|sexual|porn|nude|naked|erotic|fetish)\b[^.]*\b(child|minor|underage|teen|kid|preteen|infant|baby)s?\b/i, category: 'csam' },
  { pattern: /\bcsam\b/i, category: 'csam' },
  { pattern: /\bpedo(phil|philia|phile)/i, category: 'csam' },
  { pattern: /\bloli(con|ta)/i, category: 'csam' },
  { pattern: /\bshota(con)?\b/i, category: 'csam' },

  // Weapons of mass destruction — synthesis / weaponisation only
  // (research INTO pathogens is fine; weaponising them is not)
  { pattern: /\b(weaponi[sz]e|weaponi[sz]ing|weaponi[sz]ation)\b[^.]*\b(virus|bacteria|pathogen|anthrax|ricin|smallpox|ebola|sarin|vx|novichok|botulin)/i, category: 'wmd-bio' },
  { pattern: /\b(virus|bacteria|pathogen|anthrax|ricin|smallpox|ebola|sarin|vx|novichok|botulin)\b[^.]*\b(weaponi[sz]e|weaponi[sz]ing|weaponi[sz]ation|bioterror|bioweapon)/i, category: 'wmd-bio' },
  { pattern: /\b(make|create|build|synthesi[sz]e|produce|manufacture)\b[^.]*\b(nerve agent|sarin|vx|novichok|tabun|soman|chemical weapon|nuclear weapon|dirty bomb|fissile material)/i, category: 'wmd-chem-nuke' },
  { pattern: /\b(dirty bomb|enrich uranium|enrich plutonium|nuclear device)/i, category: 'wmd-nuke' },
  { pattern: /\bbioweapon\b/i, category: 'wmd-bio' },

  // Targeted violence — instructions to harm specific people/groups
  { pattern: /\b(how|instructions?|guide|tutorial|recipe)\b[^.]*\b(kill|murder|assassinate|attack|bomb|shoot)\b[^.]*\b(person|people|someone|group|community)/i, category: 'violence' },
  { pattern: /\b(mass shooting|school shooting|terror attack|terrorist attack)\b[^.]*\b(plan|planning|carry out|execute)/i, category: 'violence' },

  // Doxxing
  { pattern: /\b(dox|doxx|doxing|doxxing)\b/i, category: 'doxxing' },
];

export interface DenylistResult {
  ok: boolean;
  /** Coarse category, for audit logging only. Not echoed to submitter. */
  category?: string;
}

export function runHardDenylist(text: string): DenylistResult {
  const normalised = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_*~`>]+/g, ' ');
  for (const { pattern, category } of HARD_DENY_PATTERNS) {
    if (pattern.test(normalised)) {
      return { ok: false, category };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Layer 2: biomedical-scope gate (Groq)                              */
/* ------------------------------------------------------------------ */

const BIOMED_GATE_MODEL = 'llama-3.3-70b-versatile';
const BIOMED_GATE_FALLBACK_MODEL = 'llama-3.1-8b-instant';
const BIOMED_GATE_TIMEOUT_MS = 6000;

const BIOMED_GATE_SYSTEM = `You are a biomedical-scope classifier for EticaLabs, a community research platform.

A submission is IN SCOPE if it concerns biomedical research, structural biology, drug discovery, protein engineering, pharmacology, immunology, oncology, neurology, public health, epidemiology, biotechnology, vaccines, diagnostics, or directly-related life-sciences work.

A submission is OUT OF SCOPE if it concerns finance, gambling, weapons, illegal drug synthesis, sexual content, violence, doxxing, politics, or anything not directly biomedical.

Reply with exactly one word, lowercase: "yes" if the submission is in scope, "no" if it is out of scope, or "unclear" if you cannot determine the scope with high confidence.`;

export type BiomedicalGateVerdict = 'yes' | 'no' | 'unclear';

export interface BiomedicalGateResult {
  verdict: BiomedicalGateVerdict;
  /** Raw verbatim model output, for audit logging. */
  raw?: string;
  /** Network/parse error, if any. Caller treats as 'unclear' (fail-closed). */
  error?: string;
}

/**
 * Call Groq to classify whether the submission is in biomedical scope.
 * Fail-closed: any network/parse failure returns `unclear` so the
 * caller can reject the submission rather than letting it through.
 */
export async function runBiomedicalGate(
  prompt: string,
  apiKey: string,
): Promise<BiomedicalGateResult> {
  // `apiKey` is still accepted for backwards compatibility, but groqChat
  // reads the full key pool (GROQ_API_KEYS rotation + single-key fallbacks)
  // so we get multi-key rotation + retry + cascade for free here.
  if (!apiKey && !process.env.GROQ_API_KEYS && !process.env.GROQ_API_KEY) {
    return { verdict: 'unclear', error: 'missing-groq-key' };
  }
  try {
    const result = await groqChat({
      models: [BIOMED_GATE_MODEL, BIOMED_GATE_FALLBACK_MODEL],
      temperature: 0,
      max_tokens: 4,
      timeoutMs: BIOMED_GATE_TIMEOUT_MS,
      maxRetriesPerKey: 2,
      messages: [
        { role: 'system', content: BIOMED_GATE_SYSTEM },
        { role: 'user', content: prompt.slice(0, 1200) },
      ],
    });
    const raw = result.content.trim().toLowerCase();
    if (raw.startsWith('yes')) return { verdict: 'yes', raw };
    if (raw.startsWith('no')) return { verdict: 'no', raw };
    return { verdict: 'unclear', raw };
  } catch (err) {
    if (err instanceof GroqError) {
      return { verdict: 'unclear', error: `groq-${err.status || 'error'}` };
    }
    return {
      verdict: 'unclear',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Layer 4: community moderation thresholds                           */
/* ------------------------------------------------------------------ */

/**
 * Decide whether a (flagCount, vouchCount) pair should auto-hide,
 * auto-restore, or leave the current status alone. Operator-overridden
 * items are ignored entirely — callers must not invoke this on them.
 */
export function evaluateCommunityVerdict(
  current: ModerationStatus,
  flagCount: number,
  vouchCount: number,
): ModerationStatus | null {
  if (current === 'operator-hidden' || current === 'operator-approved' || current === 'denied') {
    return null;
  }
  if (current === 'visible') {
    if (flagCount >= COMMUNITY_HIDE_THRESHOLD && flagCount > vouchCount) {
      return 'hidden';
    }
    return null;
  }
  if (current === 'hidden') {
    if (vouchCount >= flagCount + COMMUNITY_RESTORE_DELTA) {
      return 'visible';
    }
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Display helpers                                                    */
/* ------------------------------------------------------------------ */

export function isPubliclyVisible(status: ModerationStatus): boolean {
  return status === 'visible' || status === 'operator-approved';
}

export function isWorkerEligible(status: ModerationStatus): boolean {
  return status === 'visible' || status === 'operator-approved';
}
