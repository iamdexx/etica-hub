import { describe, expect, it } from 'vitest';

import {
  canonicalDisease,
  cleanProse,
  cleanPrompt,
  editorialTitle,
  inferDisease,
  isPlumbingTitle,
  resolveDisease,
} from '@/lib/labs/editorial';

describe('cleanPrompt', () => {
  it('keeps a well-formed research prompt untouched', () => {
    const p =
      'Design a KRAS-G12D selective helical peptide occupying the switch II pocket for pancreatic cancer';
    expect(cleanPrompt(p)).toBe(p);
  });

  it('strips planner narration before the prompt', () => {
    expect(
      cleanPrompt(
        'I think the most promising next direction is: Engineer a thermostable lysozyme variant with enhanced activity against MRSA',
      ),
    ).toBe('Engineer a thermostable lysozyme variant with enhanced activity against MRSA');
  });

  it('recovers the quoted payload from a character-count aside', () => {
    expect(
      cleanPrompt(
        'Count chars: "Perform deep mutational scanning of the nanobody paratope against the spike RBD',
      ),
    ).toBe('Perform deep mutational scanning of the nanobody paratope against the spike RBD');
  });

  it('rejects pure meta-commentary', () => {
    expect(
      cleanPrompt("I'll choose one that builds directly on the finding from the previous run"),
    ).toBeNull();
    expect(cleanPrompt('Count chars: 178')).toBeNull();
  });

  it('rejects a fragment left by an upstream character cap', () => {
    expect(cleanPrompt('Engineer tumor-protease-cle')).toBeNull();
  });
});

describe('cleanProse', () => {
  it('drops narration but keeps the sentence', () => {
    expect(cleanProse("Here's the hypothesis: a stapled helix restores p53 signalling")).toBe(
      'a stapled helix restores p53 signalling',
    );
  });
});

describe('disease inference', () => {
  it('maps targets to conditions', () => {
    expect(inferDisease('KRAS-G12D switch II binder')).toBe('Pancreatic Cancer');
    expect(inferDisease('nanobody against the SARS-CoV-2 spike RBD')).toBe('COVID-19');
    expect(inferDisease('TDP-43 aggregation inhibitor')).toBe('Amyotrophic Lateral Sclerosis');
    expect(inferDisease('cationic peptide against Pseudomonas biofilms')).toBe(
      'Antimicrobial Resistance',
    );
  });

  it('collapses alias facets and refuses internal labels', () => {
    expect(canonicalDisease('sarbecovirus infections')).toBe('COVID-19');
    expect(canonicalDisease('cancer immunotherapy checkpoint')).toBe('Cancer Immunotherapy');
    expect(canonicalDisease('curated fallback')).toBeUndefined();
    expect(canonicalDisease('fallback')).toBeUndefined();
  });
});

describe('editorialTitle', () => {
  it('replaces an internal seed label with a condition-prefixed topic', () => {
    const title = editorialTitle(
      'Curated Fallback',
      'Develop a KRAS-G12D selective helical peptide occupying the switch II pocket for pancreatic cancer',
    );
    expect(title.startsWith('Pancreatic Cancer — ')).toBe(true);
    expect(title.toLowerCase()).not.toContain('fallback');
  });

  it('rebuilds a bare topic-pool string', () => {
    const title = editorialTitle(
      'novel peptide inhibitor design',
      'Design a beta-hairpin peptide that disrupts amyloid-beta oligomerisation for early Alzheimer disease',
    );
    expect(title.startsWith("Alzheimer's Disease — ")).toBe(true);
  });

  it('keeps an already-encyclopedic title', () => {
    const title = editorialTitle(
      'Ovarian Cancer — EGFR Loop Peptide Binding Optimization',
      'Refine the EGFR loop peptide binding interface',
    );
    expect(title).toBe('Ovarian Cancer — EGFR Loop Peptide Binding Optimization');
  });

  it('never emits raw sequences or internal ordinals', () => {
    const title = editorialTitle(
      'Candidate #3 KLAVKLADKLAVKLAD refinement',
      'Optimise the amphipathic helix for Pseudomonas aeruginosa biofilm penetration',
    );
    expect(title).not.toMatch(/KLAVKLAD/);
    expect(title).not.toMatch(/#\s*\d/);
    expect(title.startsWith('Antimicrobial Resistance — ')).toBe(true);
  });

  it('preserves gene and acronym casing', () => {
    const title = editorialTitle(
      undefined,
      'Design a KRAS-G12D selective helical peptide for the switch II pocket',
    );
    expect(title).toContain('KRAS-G12D');
  });

  it('keeps a specific campaign condition instead of the generic rule', () => {
    const title = editorialTitle(
      'Pancreatic Cancer — Driver Directed Design',
      'Measure GDF15-binding affinity and cachexia-neutralizing potency of the miniprotein',
    );
    expect(title).toBe(
      'Pancreatic Cancer — GDF15-binding Affinity and Cachexia-neutralizing Potency',
    );
  });

  it('does not recase symbols, and never opens on a conjunction or dangles', () => {
    expect(
      editorialTitle(
        'Curated Fallback',
        'Express and purify the ncAA-crosslinked nanobody bound to the SARS-CoV-2 spike RBD guided by cryo-EM',
      ),
    ).toBe('COVID-19 — ncAA-crosslinked Nanobody');
  });

  it('titles a narration-only run from what the run actually did', () => {
    const title = editorialTitle(
      'Curated Fallback',
      '',
      'Targeted CDR loop diversification on high-affinity scaffolds will yield broader neutralisation',
    );
    expect(title).toBe(
      'Biomedical Research — Targeted CDR Loop Diversification on High-affinity Scaffolds',
    );
  });

  it('always produces a condition-prefixed title', () => {
    const title = editorialTitle('Curated Fallback', 'Design a peptide with improved solubility');
    expect(title).toMatch(/^[^—]+ — .+/);
  });
});

describe('isPlumbingTitle / resolveDisease', () => {
  it('flags internal labels and prompt-shaped titles', () => {
    expect(isPlumbingTitle('Curated Fallback')).toBe(true);
    expect(isPlumbingTitle('Auto-Seed')).toBe(true);
    expect(isPlumbingTitle(undefined)).toBe(true);
    expect(isPlumbingTitle('Design a cyclic peptide inhibitor of PD-L1')).toBe(true);
    expect(isPlumbingTitle('Melanoma — PD-1/PD-L1 Interface Cyclic Peptide')).toBe(false);
  });

  it('falls back to the prompt when the title carries no condition', () => {
    expect(resolveDisease('Curated Fallback', 'IL-17A blocking peptide for psoriasis')).toBe(
      'Psoriasis',
    );
    expect(resolveDisease('Melanoma — Checkpoint Peptide', 'anything')).toBe('Melanoma');
  });
});
