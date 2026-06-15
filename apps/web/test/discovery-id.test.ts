import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';
import {
  discoveryBranchId,
  parseDiscoveryBranchId,
  parentDiscoveryBranchId,
} from '../src/lib/labs/discovery-id';

const GOAL = '1f43dd73-05d2-4de3-bc4f-4ecba7ff4f4c';

describe('discoveryBranchId', () => {
  it('scopes the branch id to the candidate so each candidate is independently mintable', () => {
    expect(discoveryBranchId(GOAL, 0)).toBe(`${GOAL}#0`);
    expect(discoveryBranchId(GOAL, 7)).toBe(`${GOAL}#7`);
    // Different candidates of the same goal hash to different branch keys —
    // this is what stops the second candidate reverting BranchAlreadyClaimed.
    expect(keccak256(stringToBytes(discoveryBranchId(GOAL, 0)))).not.toBe(
      keccak256(stringToBytes(discoveryBranchId(GOAL, 1))),
    );
  });
});

describe('parseDiscoveryBranchId', () => {
  it('round-trips a per-candidate id', () => {
    expect(parseDiscoveryBranchId(discoveryBranchId(GOAL, 3))).toEqual({
      goalId: GOAL,
      candidateIndex: 3,
    });
  });

  it('treats a bare (legacy) goal id as candidate-less', () => {
    expect(parseDiscoveryBranchId(GOAL)).toEqual({ goalId: GOAL });
  });

  it('does not misparse a trailing non-numeric # segment', () => {
    expect(parseDiscoveryBranchId(`${GOAL}#abc`)).toEqual({ goalId: `${GOAL}#abc` });
  });
});

describe('parentDiscoveryBranchId', () => {
  it('reconstructs the exact ancestor candidate id for a modern parent', () => {
    expect(parentDiscoveryBranchId(GOAL, 2)).toBe(`${GOAL}#2`);
  });

  it('falls back to the bare goal id for a legacy parent (no candidate index)', () => {
    expect(parentDiscoveryBranchId(GOAL, undefined)).toBe(GOAL);
  });

  it('is empty for a root discovery (no parent)', () => {
    expect(parentDiscoveryBranchId(undefined, undefined)).toBe('');
    expect(parentDiscoveryBranchId(undefined, 4)).toBe('');
  });

  it('matches the parent token branch id a child cascade must anchor to', () => {
    // A parent candidate mints under this branch id…
    const parentBranchId = discoveryBranchId(GOAL, 5);
    // …and a child branched from it stores goalId + candidateIndex, which must
    // reconstruct the same string so the on-chain cascade walk resolves.
    const parsed = parseDiscoveryBranchId(parentBranchId);
    expect(parentDiscoveryBranchId(parsed.goalId, parsed.candidateIndex)).toBe(parentBranchId);
  });
});
