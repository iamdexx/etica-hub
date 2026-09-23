import { describe, expect, it } from 'vitest';

import {
  parseCaAtoms,
  repeatFraction,
  sequenceIdentity,
  shannonEntropy,
  verifyCandidate,
  verificationSummary,
} from '@etica-hub/shared/labs/verify';

import { pickBestCandidate, verifyRun } from '@/lib/labs/verification';

/** Minimal Cα-only PDB builder. */
function caPdb(points: Array<[number, number, number]>, plddt = 90): string {
  return points
    .map(([x, y, z], i) => {
      const serial = String(i + 1).padStart(5, ' ');
      const res = String(i + 1).padStart(4, ' ');
      const f = (v: number) => v.toFixed(3).padStart(8, ' ');
      const b = plddt.toFixed(2).padStart(6, ' ');
      return `ATOM  ${serial}  CA  ALA A${res}    ${f(x)}${f(y)}${f(z)}  1.00${b}           C`;
    })
    .join('\n');
}

/** Straight rod along x at 3.8 Å spacing — an idealised single helix axis. */
function rod(n: number, plddt = 92): string {
  return caPdb(
    Array.from({ length: n }, (_, i) => [i * 3.8, 0, 0] as [number, number, number]),
    plddt,
  );
}

/** Compact globule: points on a small sphere shell, many long-range contacts. */
function globule(n: number, plddt = 85): string {
  const pts: Array<[number, number, number]> = [];
  const r = 1.8 * Math.pow(n, 0.38);
  for (let i = 0; i < n; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    pts.push([
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi),
    ]);
  }
  return caPdb(pts, plddt);
}

const REAL_LIKE = 'SIYDFGSAEWQTKLNHRVMPCGTYEKLFDNAQWRHSVMIPTCGKEDLYNQARFHW';

describe('sequence metrics', () => {
  it('entropy separates a homopolymer from a diverse sequence', () => {
    expect(shannonEntropy('AAAAAAAAAAAA')).toBe(0);
    expect(shannonEntropy(REAL_LIKE)).toBeGreaterThan(3.5);
  });

  it('repeatFraction detects tandem repeats', () => {
    expect(repeatFraction('KLAVKLADKLAVKLADKLAVKLADKLAVKLAD')).toBeGreaterThan(0.8);
    expect(repeatFraction(REAL_LIKE)).toBeLessThan(0.3);
  });

  it('sequenceIdentity is length-aware', () => {
    expect(sequenceIdentity('ACDEFG', 'ACDEFG')).toBe(1);
    expect(sequenceIdentity('ACDEFG', 'ACDEFGHIKL')).toBeCloseTo(0.6, 5);
  });
});

describe('verifyCandidate — sequence checks', () => {
  it('rejects a poly-proline rod even at high pLDDT', () => {
    const seq = 'APPPPPPAAPAPAAAPPPAPPPPPPPPPPPAPPPPPPPPPP';
    const result = verifyCandidate({ sequence: seq, pdb: rod(seq.length, 95), folded: true });
    expect(result.grade).toBe('rejected');
    expect(result.penalty).toBe(0);
    expect(result.metrics.plddtMean).toBeGreaterThan(90);
    expect(verificationSummary(result)).toMatch(/complexity|Composition|repeat/i);
  });

  it('rejects a KLAVKLAD tandem repeat', () => {
    const seq = 'KLAVKLADKLAVKLADKLAVKLADKLAVKLADKLAVKLAD';
    const result = verifyCandidate({ sequence: seq, pdb: rod(seq.length), folded: true });
    expect(result.grade).toBe('rejected');
    expect(result.checks.find((c) => c.id === 'repeats')?.status).toBe('fail');
  });

  it('rejects non-canonical residues and out-of-range lengths', () => {
    expect(verifyCandidate({ sequence: 'ACDEFGHIKXZ' }).checks.find((c) => c.id === 'residues')
      ?.status).toBe('fail');
    expect(verifyCandidate({ sequence: 'ACDE' }).checks.find((c) => c.id === 'length')?.status).toBe(
      'fail',
    );
  });

  it('flags a near-duplicate sibling', () => {
    const peer = `${REAL_LIKE.slice(0, -1)}A`;
    const result = verifyCandidate({ sequence: REAL_LIKE, peers: [peer] });
    expect(result.checks.find((c) => c.id === 'novelty')?.status).toBe('fail');
  });

  it('passes a diverse sequence with a compact structure', () => {
    const result = verifyCandidate({
      sequence: REAL_LIKE,
      pdb: globule(REAL_LIKE.length),
      folded: true,
    });
    expect(result.grade).toBe('verified');
    expect(result.penalty).toBe(1);
  });
});

describe('verifyCandidate — structure checks', () => {
  it('calls out an extended rod with no tertiary contacts', () => {
    const result = verifyCandidate({ sequence: REAL_LIKE, pdb: rod(REAL_LIKE.length), folded: true });
    const tertiary = result.checks.find((c) => c.id === 'tertiary');
    expect(tertiary?.status).toBe('fail');
    expect(result.metrics.longRangeContactDensity).toBe(0);
    expect(result.metrics.compactness).toBeLessThan(0.55);
  });

  it('accepts a globular fold as having tertiary structure', () => {
    const result = verifyCandidate({ sequence: REAL_LIKE, pdb: globule(REAL_LIKE.length) });
    expect(result.checks.find((c) => c.id === 'tertiary')?.status).toBe('pass');
    expect(result.metrics.longRangeContactDensity!).toBeGreaterThan(0.1);
  });

  it('warns when no structure was predicted', () => {
    const result = verifyCandidate({ sequence: REAL_LIKE, folded: false });
    expect(result.checks.find((c) => c.id === 'structure')?.status).toBe('warn');
    expect(result.grade).toBe('weak');
    expect(result.penalty).toBeLessThan(1);
  });

  it('normalises 0–1 pLDDT from ESM Atlas to 0–100', () => {
    const atoms = parseCaAtoms(globule(30, 0.87));
    expect(atoms[0]!.plddt).toBeCloseTo(87, 5);
  });

  it('fails a low-confidence fold', () => {
    const result = verifyCandidate({ sequence: REAL_LIKE, pdb: globule(REAL_LIKE.length, 35) });
    expect(result.checks.find((c) => c.id === 'plddt')?.status).toBe('fail');
    expect(result.grade).toBe('rejected');
  });
});

describe('run ranking', () => {
  const junk = 'APPPPPPAAPAPAAAPPPAPPPPPPPPPPPAPPPPPPPPPP';
  const candidates = [
    { index: 0, sequence: junk, score: 0.93, folded: true },
    { index: 1, sequence: REAL_LIKE, score: 0.71, folded: true },
  ];
  const pdbFor = (c: { index: number; sequence: string }) =>
    c.index === 0 ? rod(junk.length, 95) : globule(REAL_LIKE.length);

  it('does not publish a higher-scoring rejected candidate as best', () => {
    const verifications = verifyRun(candidates, pdbFor);
    expect(verifications.get(0)!.grade).toBe('rejected');
    expect(verifications.get(1)!.grade).toBe('verified');
    expect(pickBestCandidate(candidates, verifications).index).toBe(1);
  });

  it('falls back to raw score when everything is rejected', () => {
    const allJunk = [
      { index: 0, sequence: junk, score: 0.5, folded: true },
      { index: 1, sequence: `${junk}PP`, score: 0.9, folded: true },
    ];
    const verifications = verifyRun(allJunk, () => rod(junk.length, 95));
    expect(pickBestCandidate(allJunk, verifications).index).toBe(1);
  });
});
