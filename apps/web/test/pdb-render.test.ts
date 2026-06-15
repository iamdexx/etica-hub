import { describe, it, expect } from 'vitest';
import { parseCaTrace, extractCaPdb, buildRibbonSvg, plddtColor } from '../src/lib/labs/pdb-render';

// A tiny synthetic ESMFold-style PDB: 6 CA atoms with pLDDT in B-factor col,
// plus some non-CA atoms that must be ignored.
const PDB = [
  'ATOM      1  N   MET A   1      11.104  13.207  10.000  1.00 95.00           N',
  'ATOM      2  CA  MET A   1      12.560  13.500  10.500  1.00 95.00           C',
  'ATOM      3  C   MET A   1      13.000  14.900  10.100  1.00 95.00           C',
  'ATOM      4  CA  ALA A   2      15.100  16.200  12.000  1.00 88.00           C',
  'ATOM      5  CA  GLY A   3      17.800  18.000  14.500  1.00 72.00           C',
  'ATOM      6  CA  LEU A   4      20.100  20.900  11.000  1.00 60.00           C',
  'ATOM      7  CA  VAL A   5      22.500  17.300   9.000  1.00 45.00           C',
  'ATOM      8  CA  LYS A   6      25.000  15.000  13.200  1.00 92.00           C',
  'ENDMDL',
  'ATOM      9  CA  XXX B   1       0.000   0.000   0.000  1.00 10.00           C',
].join('\n');

describe('pdb-render', () => {
  it('parses only first-model CA atoms with pLDDT', () => {
    const trace = parseCaTrace(PDB);
    expect(trace.length).toBe(6); // 6 CAs before ENDMDL, ignores N/C and model 2
    expect(trace[0]!.plddt).toBe(95);
    expect(trace[5]!.plddt).toBe(92);
  });

  it('extractCaPdb keeps only CA lines of the first model', () => {
    const ca = extractCaPdb(PDB);
    const lines = ca.split('\n');
    expect(lines.length).toBe(6);
    expect(lines.every((l) => l.slice(12, 16).trim() === 'CA')).toBe(true);
  });

  it('colours pLDDT by AlphaFold bands', () => {
    expect(plddtColor(95)).toBe('#0053d6');
    expect(plddtColor(80)).toBe('#65cbf3');
    expect(plddtColor(60)).toBe('#ffdb13');
    expect(plddtColor(40)).toBe('#ff7d45');
  });

  it('renders a 3D cartoon-ribbon SVG with backbone tube segments', () => {
    const render = buildRibbonSvg(PDB, {
      meta: {
        tokenId: '7',
        title: 'Test peptide inhibitor',
        scoreStr: '0.88',
        seqLen: 6,
        subtitle: '3 iterations · block #100',
      },
    });
    expect(render).not.toBeNull();
    expect(render!.residues).toBe(6);
    expect(render!.svg.startsWith('<svg')).toBe(true);
    // Spline subdivision turns 6 CAs into many smooth tube segments.
    expect((render!.svg.match(/<line /g) ?? []).length).toBeGreaterThan(5);
    // NFT-card chrome includes the token id + spectrum legend.
    expect(render!.svg).toContain('ETICA RESEARCH NFT');
    expect(render!.svg).toContain('#7');
  });

  it('returns null for a PDB with too few CA atoms', () => {
    expect(buildRibbonSvg('ATOM      2  CA  MET A   1       1.000   1.000   1.000  1.00 95.00')).toBeNull();
  });
});
