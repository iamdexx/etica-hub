import { describe, expect, it } from 'vitest';

import type { ArchivedResearch } from '@/lib/labs/archive';
import { forfeitPayload, prepareForfeit } from '@/lib/labs/treasury-crank';

const TREASURY = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';
const NOW = 1_800_000_000;

function record(overrides: Partial<ArchivedResearch> = {}): ArchivedResearch {
  return {
    id: 'archive-1',
    jobId: 'job-1',
    goalId: 'goal-1',
    goalTitle: 'Pancreatic Cancer — KRAS G12D switch II binder',
    prompt: 'Design a KRAS G12D selective binder',
    completedAt: 1,
    hypothesis: 'h',
    approach: 'a',
    bestCandidate: {
      index: 2,
      sequence: 'MKTAYIAKQRQISFVKSHFSRQ',
      rationale: 'r',
      score: 0.74,
      folded: true,
    },
    candidates: [],
    iterations: 3,
    summary: 's',
    references: [],
    minted: false,
    ...overrides,
  } as ArchivedResearch;
}

describe('prepareForfeit', () => {
  it('settles under the per-candidate branch id, matching the user-mint scheme', () => {
    expect(prepareForfeit(record())).toEqual({ goalId: 'goal-1', branchGoalId: 'goal-1#2' });
  });

  it('skips a record with no goal id or no sequence', () => {
    expect(prepareForfeit(record({ goalId: undefined }))).toMatchObject({ reason: 'no goalId' });
    expect(
      prepareForfeit(record({ bestCandidate: { ...record().bestCandidate, sequence: '' } })),
    ).toMatchObject({ reason: 'no sequence' });
  });
});

describe('forfeitPayload', () => {
  it('closes both windows so the contract force-mints to the treasury', () => {
    const p = forfeitPayload(record(), 'goal-1#2', NOW);
    expect(p.exclusiveUntil).toBeLessThan(BigInt(NOW));
    expect(p.marketOpenUntil).toBeLessThan(BigInt(NOW));
    expect(p.marketOpenUntil).toBeGreaterThanOrEqual(p.exclusiveUntil);
    expect(p.expiresAt).toBeGreaterThan(BigInt(NOW));
  });

  it('scores in basis points, clamped', () => {
    expect(forfeitPayload(record(), 'b', NOW).score).toBe(7400n);
    const hot = record({ bestCandidate: { ...record().bestCandidate, score: 3 } });
    expect(forfeitPayload(hot, 'b', NOW).score).toBe(10_000n);
  });

  it('attributes an auto-seeded record to the treasury sentinel', () => {
    expect(forfeitPayload(record(), 'b', NOW).submitter).toBe(TREASURY);
    expect(
      forfeitPayload(record({ submitterWallet: '0x' + 'ab'.repeat(20) }), 'b', NOW).submitter,
    ).toBe('0x' + 'ab'.repeat(20));
  });

  it('carries the parent branch id for lineage', () => {
    const p = forfeitPayload(
      record({ parentGoalId: 'goal-0', parentCandidateIndex: 1 }),
      'goal-1#2',
      NOW,
    );
    expect(p.parentBranchGoalId).toBe('goal-0#1');
  });
});
