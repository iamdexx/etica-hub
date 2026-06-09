/**
 * Deterministic point-mutation generator for autopilot iterations.
 *
 * We don't ask the LLM to mutate — it's slow and adds non-determinism.
 * Instead we pick three biophysically meaningful single-residue swaps:
 *   1. Random conservative swap (similar physicochemistry)
 *   2. Random radical swap (different physicochemistry)
 *   3. Helix-boost: turn a residue at the middle into A (helix-favouring)
 *
 * If the sequence is short (< 12 aa) we shrink the mutation set to 1-2
 * to avoid spamming near-identical mutants.
 */

export type Mutation = {
  sequence: string;
  description: string;
};

// Buckets of physicochemically similar residues.
const CONSERVATIVE: Record<string, string[]> = {
  A: ['V', 'L', 'I'],
  V: ['L', 'I', 'A'],
  L: ['I', 'V', 'M'],
  I: ['L', 'V', 'M'],
  M: ['L', 'I'],
  F: ['Y', 'W'],
  Y: ['F', 'W'],
  W: ['F', 'Y'],
  S: ['T'],
  T: ['S'],
  N: ['Q'],
  Q: ['N'],
  D: ['E'],
  E: ['D'],
  K: ['R'],
  R: ['K', 'H'],
  H: ['K', 'R'],
  C: ['S'],
  P: ['A'],
  G: ['A'],
};

const RADICAL: Record<string, string[]> = {
  A: ['D', 'K', 'F'],
  V: ['D', 'R', 'S'],
  L: ['D', 'K', 'S'],
  I: ['E', 'R', 'T'],
  M: ['D', 'K', 'P'],
  F: ['D', 'K', 'P'],
  Y: ['D', 'K', 'P'],
  W: ['D', 'E', 'P'],
  S: ['F', 'W', 'R'],
  T: ['F', 'W', 'K'],
  N: ['L', 'F', 'P'],
  Q: ['I', 'W', 'P'],
  D: ['F', 'V', 'L'],
  E: ['F', 'I', 'L'],
  K: ['F', 'V', 'L'],
  R: ['F', 'V', 'I'],
  H: ['L', 'V', 'P'],
  C: ['K', 'D', 'F'],
  P: ['K', 'D', 'F'],
  G: ['F', 'K', 'D'],
};

function pick<T>(items: T[], rng: () => number): T {
  const idx = Math.floor(rng() * items.length);
  return items[Math.max(0, Math.min(items.length - 1, idx))]!;
}

function mutateAt(sequence: string, position: number, replacement: string): string {
  if (position < 0 || position >= sequence.length) return sequence;
  return sequence.slice(0, position) + replacement + sequence.slice(position + 1);
}

/**
 * Seeded PRNG so mutations are reproducible across worker reruns for the
 * same input — handy for debugging.
 */
function makeRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mutateSequence(parent: string, n: number): Mutation[] {
  if (!parent || n <= 0) return [];
  const rng = makeRng(parent);
  const mutations: Mutation[] = [];

  // 1. Conservative swap.
  if (mutations.length < n && parent.length >= 4) {
    const pos = Math.floor(rng() * parent.length);
    const orig = parent[pos]!;
    const pool = CONSERVATIVE[orig] ?? ['A'];
    const replacement = pick(pool, rng);
    if (replacement !== orig) {
      mutations.push({
        sequence: mutateAt(parent, pos, replacement),
        description: `conservative ${orig}${pos + 1}${replacement}`,
      });
    }
  }

  // 2. Radical swap.
  if (mutations.length < n && parent.length >= 4) {
    const pos = Math.floor(rng() * parent.length);
    const orig = parent[pos]!;
    const pool = RADICAL[orig] ?? ['F'];
    const replacement = pick(pool, rng);
    if (replacement !== orig) {
      mutations.push({
        sequence: mutateAt(parent, pos, replacement),
        description: `radical ${orig}${pos + 1}${replacement}`,
      });
    }
  }

  // 3. Helix-favouring substitution in the middle third.
  if (mutations.length < n) {
    const lower = Math.floor(parent.length / 3);
    const upper = Math.floor((parent.length * 2) / 3);
    if (upper > lower) {
      const pos = lower + Math.floor(rng() * Math.max(1, upper - lower));
      const orig = parent[pos]!;
      const replacement = orig === 'A' ? 'L' : 'A';
      if (replacement !== orig) {
        mutations.push({
          sequence: mutateAt(parent, pos, replacement),
          description: `helix-boost ${orig}${pos + 1}${replacement}`,
        });
      }
    }
  }

  return mutations.slice(0, n);
}
