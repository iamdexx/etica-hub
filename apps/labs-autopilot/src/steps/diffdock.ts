/**
 * DiffDock step — drug-protein docking simulation via Nvidia NIM.
 *
 * Given a PDB structure from ESMFold and a ligand (SDF/MOL2), DiffDock
 * predicts binding poses — where a drug molecule would attach to the
 * protein and with what confidence.
 *
 * This adds docking insight to the research pipeline: after folding a
 * protein, we can test whether known drugs bind to it (drug repurposing)
 * or evaluate designed molecules for binding affinity.
 *
 * Endpoint: https://health.api.nvidia.com/v1/biology/mit/diffdock
 * Auth: Bearer NVIDIA_API_KEY (same key as ESMFold + Nemotron)
 */

import { readNvidiaKeyPool } from './fold.js';

const DIFFDOCK_URL = 'https://health.api.nvidia.com/v1/biology/mit/diffdock';
const TIMEOUT_MS = 180_000; // 3 min — docking is computationally heavy
/** Infinite retry — never fail. Exponential backoff capped at 60s. */
function backoffFor(attempt: number): number {
  if (attempt === 0) return 0;
  return Math.min(60_000, 5_000 * 2 ** (attempt - 1));
}

export interface DiffDockInput {
  /** PDB protein content (ATOM lines) */
  protein: string;
  /** Ligand molecule in SDF or MOL2 format */
  ligand: string;
  /** File type of the ligand ('sdf' | 'mol2') */
  ligandFileType: 'sdf' | 'mol2';
  /** Number of binding poses to generate (default: 5) */
  numPoses?: number;
  /** Time divisions for diffusion (default: 20) */
  timeDivisions?: number;
  /** Diffusion steps (default: 18) */
  steps?: number;
}

export interface DockingPose {
  /** SDF text of the docked ligand position */
  ligandSdf: string;
  /** Confidence score (higher = more likely to be correct) */
  confidence: number;
}

export interface DiffDockResult {
  ok: true;
  poses: DockingPose[];
  /** Best confidence score across all poses */
  bestConfidence: number;
  durationMs: number;
}

export interface DiffDockError {
  ok: false;
  error: string;
  durationMs: number;
}

export type DiffDockOutcome = DiffDockResult | DiffDockError;

let _roundRobin = 0;
function nextKey(): string | null {
  const keys = readNvidiaKeyPool();
  if (keys.length === 0) return null;
  return keys[_roundRobin++ % keys.length]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract only ATOM lines from PDB for DiffDock.
 */
function extractAtomLines(pdb: string): string {
  return pdb
    .split('\n')
    .filter((line) => line.startsWith('ATOM'))
    .join('\n');
}

/**
 * Run DiffDock to predict how a ligand binds to a protein structure.
 */
export async function dockMolecule(input: DiffDockInput): Promise<DiffDockOutcome> {
  const apiKey = nextKey();
  if (!apiKey) return { ok: false, error: 'NVIDIA_API_KEY not set', durationMs: 0 };

  const startedAt = Date.now();
  const protein = extractAtomLines(input.protein);

  if (!protein || protein.length < 50) {
    return { ok: false, error: 'Protein PDB has no ATOM lines', durationMs: Date.now() - startedAt };
  }

  if (!input.ligand || input.ligand.length < 10) {
    return { ok: false, error: 'Ligand data is empty or too short', durationMs: Date.now() - startedAt };
  }

  const body = {
    protein,
    ligand: input.ligand,
    ligand_file_type: input.ligandFileType,
    num_poses: input.numPoses ?? 5,
    time_divisions: input.timeDivisions ?? 20,
    steps: input.steps ?? 18,
    save_trajectory: false,
    is_staged: false,
  };

  for (let attempt = 0; ; attempt++) {
    const delay = backoffFor(attempt);
    if (delay > 0) await sleep(delay);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(DIFFDOCK_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 429 || response.status === 503) continue;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status >= 500) continue;
        return {
          ok: false,
          error: `DiffDock ${response.status}: ${text.slice(0, 200)}`,
          durationMs: Date.now() - startedAt,
        };
      }

      const data = (await response.json()) as {
        status?: string;
        ligand_positions?: string[];
        position_confidence?: number[];
        details?: string;
      };

      if (data.status === 'fail') {
        return {
          ok: false,
          error: `DiffDock failed: ${data.details ?? 'unknown'}`,
          durationMs: Date.now() - startedAt,
        };
      }

      const positions = data.ligand_positions ?? [];
      const confidences = data.position_confidence ?? [];

      if (positions.length === 0) {
        return {
          ok: false,
          error: 'DiffDock returned no poses',
          durationMs: Date.now() - startedAt,
        };
      }

      const poses: DockingPose[] = positions.map((sdf, i) => ({
        ligandSdf: sdf,
        confidence: confidences[i] ?? 0,
      }));

      // Sort by confidence descending
      poses.sort((a, b) => b.confidence - a.confidence);

      return {
        ok: true,
        poses,
        bestConfidence: poses[0]?.confidence ?? 0,
        durationMs: Date.now() - startedAt,
      };
    } catch {
      // Network error / timeout — retry forever
      continue;
    }
  }
}

/**
 * Common drug-like molecules that can be tested against any protein target.
 * These are simplified SMILES → SDF placeholders for common drug scaffolds.
 * In production, the pipeline would pull ligands from ChEMBL or PubChem
 * based on the disease context.
 */
export const COMMON_DRUG_SCAFFOLDS: Record<string, string> = {
  // These would be populated with actual SDF content from a drug library
  // For now, the pipeline can test docking when a ligand is provided by
  // the analysis step or from the research archive.
};
