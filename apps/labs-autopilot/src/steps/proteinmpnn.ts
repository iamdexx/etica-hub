/**
 * ProteinMPNN step — AI-designed protein sequences via Nvidia NIM.
 *
 * Given a PDB structure from ESMFold, ProteinMPNN designs new amino acid
 * sequences that fold into the same 3D backbone but with potentially
 * better properties (stability, binding affinity, etc.).
 *
 * This replaces the deterministic random-mutation approach in mutate.ts
 * with actual protein design intelligence.
 *
 * Endpoint: https://health.api.nvidia.com/v1/biology/ipd/proteinmpnn/predict
 * Auth: Bearer NVIDIA_API_KEY (same key as ESMFold + Nemotron)
 */

import { readNvidiaKeyPool } from './fold.js';

const PROTEINMPNN_URL = 'https://health.api.nvidia.com/v1/biology/ipd/proteinmpnn/predict';
const TIMEOUT_MS = 120_000; // 2 min — structure design can be slow
const MAX_RETRIES = 3;
const BACKOFF_MS = [0, 3_000, 10_000];

export interface ProteinMPNNInput {
  /** PDB content (ATOM lines) from ESMFold */
  pdb: string;
  /** Which chains to redesign (default: all) */
  chains?: string[];
  /** Sampling temperature — lower = more conservative designs */
  samplingTemp?: number;
  /** Number of sequences to generate (default: 4) */
  numSequences?: number;
}

export interface ProteinMPNNResult {
  ok: true;
  sequences: DesignedSequence[];
  durationMs: number;
}

export interface DesignedSequence {
  sequence: string;
  score: number;
  /** Recovery — how much of the original sequence was preserved */
  recoveryRate: number;
}

export interface ProteinMPNNError {
  ok: false;
  error: string;
  durationMs: number;
}

export type ProteinMPNNOutcome = ProteinMPNNResult | ProteinMPNNError;

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
 * Extract ATOM lines from a PDB to send to ProteinMPNN.
 * ProteinMPNN only needs ATOM records.
 */
function extractAtomLines(pdb: string): string {
  return pdb
    .split('\n')
    .filter((line) => line.startsWith('ATOM') || line.startsWith('TER') || line.startsWith('END'))
    .join('\n');
}

/**
 * Parse the FASTA output from ProteinMPNN into individual sequences with scores.
 */
function parseMfasta(mfasta: string, originalSequence?: string): DesignedSequence[] {
  const results: DesignedSequence[] = [];
  const entries = mfasta.split('>').filter(Boolean);

  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    const header = lines[0] ?? '';
    const sequence = lines.slice(1).join('').trim().toUpperCase();

    if (!sequence || sequence.length < 5) continue;

    // Parse score from header — format: ">T=0.1, sample 1, score=1.234, ..."
    let score = 0;
    const scoreMatch = header.match(/score=([\d.]+)/);
    if (scoreMatch) score = parseFloat(scoreMatch[1]!);

    // Calculate recovery rate vs original
    let recoveryRate = 0;
    if (originalSequence && originalSequence.length === sequence.length) {
      let matches = 0;
      for (let i = 0; i < sequence.length; i++) {
        if (sequence[i] === originalSequence[i]) matches++;
      }
      recoveryRate = matches / sequence.length;
    }

    results.push({ sequence, score, recoveryRate });
  }

  return results;
}

/**
 * Run ProteinMPNN to design new sequences for a given backbone structure.
 */
export async function designSequences(input: ProteinMPNNInput): Promise<ProteinMPNNOutcome> {
  const apiKey = nextKey();
  if (!apiKey) return { ok: false, error: 'NVIDIA_API_KEY not set', durationMs: 0 };

  const startedAt = Date.now();
  const atomPdb = extractAtomLines(input.pdb);

  if (!atomPdb || atomPdb.length < 50) {
    return { ok: false, error: 'PDB has no ATOM lines', durationMs: Date.now() - startedAt };
  }

  const body: Record<string, unknown> = {
    input_pdb: atomPdb,
    ca_only: false,
    use_soluble_model: true,
    sampling_temp: [input.samplingTemp ?? 0.1],
    num_seq_per_target: input.numSequences ?? 4,
  };
  if (input.chains?.length) {
    body.input_pdb_chains = input.chains;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const backoff = BACKOFF_MS[attempt] ?? 10_000;
    if (backoff > 0) await sleep(backoff);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(PROTEINMPNN_URL, {
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

      if (response.status === 429 || response.status === 503) {
        // Rate limited or overloaded — retry
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (attempt < MAX_RETRIES - 1 && response.status >= 500) continue;
        return {
          ok: false,
          error: `ProteinMPNN ${response.status}: ${text.slice(0, 200)}`,
          durationMs: Date.now() - startedAt,
        };
      }

      const data = (await response.json()) as { mfasta?: string; sequences?: string[] };
      const mfasta = data.mfasta;
      if (!mfasta) {
        return {
          ok: false,
          error: 'ProteinMPNN response missing mfasta field',
          durationMs: Date.now() - startedAt,
        };
      }

      // Extract original sequence from PDB for recovery comparison
      const originalSequence = extractSequenceFromPdb(atomPdb);
      const sequences = parseMfasta(mfasta, originalSequence);

      if (sequences.length === 0) {
        return {
          ok: false,
          error: 'ProteinMPNN produced no valid sequences',
          durationMs: Date.now() - startedAt,
        };
      }

      return { ok: true, sequences, durationMs: Date.now() - startedAt };
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) continue;
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'unknown error',
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return { ok: false, error: 'ProteinMPNN exhausted retries', durationMs: Date.now() - startedAt };
}

/** 3-letter → 1-letter amino acid mapping */
const AA3TO1: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C',
  GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P',
  SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
};

/** Extract amino acid sequence from PDB ATOM records (CA atoms). */
function extractSequenceFromPdb(pdb: string): string {
  const seen = new Set<string>();
  const residues: string[] = [];

  for (const line of pdb.split('\n')) {
    if (!line.startsWith('ATOM')) continue;
    const atomName = line.slice(12, 16).trim();
    if (atomName !== 'CA') continue;
    const resName = line.slice(17, 20).trim();
    const chainId = line.slice(21, 22);
    const resSeq = line.slice(22, 26).trim();
    const key = `${chainId}:${resSeq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    residues.push(AA3TO1[resName] ?? 'X');
  }

  return residues.join('');
}
