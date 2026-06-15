import { describe, it, expect } from 'vitest';
import {
  buildPlainSummary,
  confidenceTier,
  looksLikeNarration,
  scoreLabel,
} from '../src/lib/labs/plain-summary';

describe('confidenceTier', () => {
  it('maps mean pLDDT to High / Medium / Low', () => {
    expect(confidenceTier(92).label).toBe('High');
    expect(confidenceTier(80).label).toBe('High');
    expect(confidenceTier(70).label).toBe('Medium');
    expect(confidenceTier(60).label).toBe('Medium');
    expect(confidenceTier(55).label).toBe('Low');
  });
  it('rounds the score for display', () => {
    expect(confidenceTier(84.6).score).toBe(85);
  });
});

describe('buildPlainSummary', () => {
  it('is jargon-free and states length + confidence', () => {
    const out = buildPlainSummary({ residues: 38, meanPlddt: 86 });
    expect(out).toContain('38 amino acids long');
    expect(out).toContain('highly confident');
    expect(out).toContain('(86/100)');
    expect(looksLikeNarration(out)).toBe(false);
  });
  it('flags a flexible region only when a low-confidence stretch exists', () => {
    expect(buildPlainSummary({ residues: 120, meanPlddt: 72, minPlddt: 40 })).toContain(
      'less certain',
    );
    expect(buildPlainSummary({ residues: 120, meanPlddt: 72, minPlddt: 65 })).not.toContain(
      'less certain',
    );
  });
  it('treats low confidence as an early lead', () => {
    expect(buildPlainSummary({ residues: 200, meanPlddt: 45 })).toContain('early lead');
  });
});

describe('scoreLabel', () => {
  it('maps 0-1 scores to words', () => {
    expect(scoreLabel(0.9)).toBe('Strong');
    expect(scoreLabel(0.65)).toBe('Promising');
    expect(scoreLabel(0.45)).toBe('Mixed');
    expect(scoreLabel(0.2)).toBe('Weak');
  });
});

describe('looksLikeNarration', () => {
  it('detects leaked model reasoning', () => {
    expect(looksLikeNarration('The user wants a 2-3 sentence analysis of this fold.')).toBe(true);
    expect(looksLikeNarration('Let me analyze the data: Sequence...')).toBe(true);
    expect(looksLikeNarration('Key observations: the helix is...')).toBe(true);
  });
  it('passes clean summaries', () => {
    expect(looksLikeNarration('A small designed protein, 38 amino acids long.')).toBe(false);
    expect(looksLikeNarration(undefined)).toBe(false);
    expect(looksLikeNarration('')).toBe(false);
  });
});
