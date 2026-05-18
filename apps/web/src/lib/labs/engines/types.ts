/**
 * Shared types for the Labs folding engine registry.
 *
 * Engines are pluggable: each one knows how to take an amino-acid sequence
 * and return a PDB string. The registry composes them into an ordered
 * cascade so callers can transparently fail over from one engine to the
 * next when an upstream host is rate-limited, warming, or down.
 */

export type FoldEngineId = 'hf-esmfold' | 'nvidia-esmfold' | 'chai-1' | 'boltz';

export type FoldEngineDescriptor = {
  /** Stable, URL-safe identifier used in API params and UI keys. */
  id: FoldEngineId;
  /** Short, human-readable name shown in the engine selector. */
  label: string;
  /** Underlying model family (used to inform users about provenance). */
  model: string;
  /** Free-form description shown as a tooltip / helper text. */
  description: string;
  /**
   * True when the engine has all credentials/config it needs to run.
   * Engines without `isConfigured` are skipped silently in the cascade
   * and rendered as "requires <ENV_VAR>" in the UI.
   */
  isConfigured: boolean;
  /**
   * Names of env vars that need to be set to enable this engine. Surfaced
   * in the UI when `isConfigured === false` so operators know what to add.
   */
  requiredEnv: readonly string[];
};

export type FoldEngineAttempt = {
  engine: FoldEngineId;
  ok: boolean;
  /** Brief failure reason — never leaks tokens or full upstream HTML. */
  error?: string;
  /** Total wall-clock spent on this engine, in milliseconds. */
  durationMs: number;
};

export type FoldSuccess = {
  ok: true;
  pdb: string;
  sequence: string;
  engine: FoldEngineId;
  /** Per-engine attempts captured along the cascade, including success. */
  attempts: FoldEngineAttempt[];
};

export type FoldFailure = {
  ok: false;
  /** User-facing summary; safe to surface in the UI. */
  error: string;
  /** Per-engine attempts captured along the cascade. */
  attempts: FoldEngineAttempt[];
};

export type FoldOutcome = FoldSuccess | FoldFailure;

export interface FoldEngine {
  descriptor: FoldEngineDescriptor;
  /**
   * Attempt to fold a single amino-acid sequence. Implementations should
   * resolve in <= 60s on the happy path and never throw — failures are
   * reported as `{ ok: false, error }`.
   */
  fold(sequence: string): Promise<{ ok: true; pdb: string } | { ok: false; error: string }>;
}

export function looksLikePdb(payload: string): boolean {
  return payload.includes('ATOM') || payload.includes('HEADER') || payload.includes('MODEL');
}
