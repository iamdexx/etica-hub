import { describe, expect, it } from 'vitest';
import type { ArchivedResearch } from '@/lib/labs/archive';
import {
  LABS_DATA_LICENSE,
  researchCredit,
  researchCreditMetadata,
  unmetDisulfideObjective,
} from '@/lib/labs/research-credit';

const wallet = '0xb3c3080802fc050172fdbc9dF92BD435226212E6';
const seed = { submitterTag: 'autopilot-seed' };

describe('researchCredit', () => {
  it('only attributes confirmed autopilot roots to the named creator', async () => {
    const credit = await researchCredit({ goalId: 'root' }, async () => seed);
    expect(credit).toEqual({
      kind: 'eticahub',
      name: 'Deaven Mabry',
      affiliation: 'EticaHub Labs',
      rootGoalId: 'root',
    });
    expect(researchCreditMetadata(credit)).toMatchObject({
      creator: { name: 'Deaven Mabry' },
      license: LABS_DATA_LICENSE,
    });
  });

  it('preserves record wallets without assigning a license or affiliation', async () => {
    const credit = await researchCredit({ submitterWallet: wallet });
    expect(researchCreditMetadata(credit)).toEqual({
      creator: { '@type': 'Person', name: wallet },
    });
  });

  it('walks automatic branches back to community originators', async () => {
    const credit = await researchCredit({ goalId: 'branch' }, async (id) =>
      id === 'branch' ? { ...seed, parentGoalId: 'root' } : { ...seed, submitterWallet: wallet },
    );
    expect(credit).toEqual({ kind: 'community', name: wallet });
  });

  it('handles owned branches without mistaking origin=user for human authorship', async () => {
    const credit = await researchCredit({ goalId: 'branch' }, async (id) =>
      id === 'branch' ? { submitterTag: 'branch', parentGoalId: 'root' } : seed,
    );
    expect(credit.kind).toBe('eticahub');
  });

  it('leaves missing goals, old anonymous roots and malformed wallets unattributed', async () => {
    expect((await researchCredit({ goalId: 'missing' }, async () => null)).kind).toBe('unknown');
    expect(
      (await researchCredit({ goalId: 'old' }, async () => ({ submitterTag: 'anon' }))).kind,
    ).toBe('unknown');
    expect((await researchCredit({ submitterWallet: '0xetc' })).kind).toBe('unknown');
    expect(researchCreditMetadata(await researchCredit({}))).toEqual({});
  });

  it('fails closed on cycles and caps lookup depth', async () => {
    expect(
      (await researchCredit({ goalId: 'root' }, async () => ({ ...seed, parentGoalId: 'root' })))
        .kind,
    ).toBe('unknown');
    let calls = 0;
    expect(
      (
        await researchCredit({ goalId: '0' }, async () => ({
          ...seed,
          parentGoalId: String(++calls),
        }))
      ).kind,
    ).toBe('unknown');
    expect(calls).toBe(64);
  });

  it('does not turn a storage failure into an ownership claim', async () => {
    await expect(
      researchCredit({ goalId: 'root' }, async () => {
        throw new Error('storage unavailable');
      }),
    ).rejects.toThrow('storage unavailable');
  });
});

describe('unmetDisulfideObjective', () => {
  const record = (sequence: string, prompt = 'Engineer disulfide staples') =>
    ({ prompt, bestCandidate: { sequence } }) as ArchivedResearch;
  it('flags fewer than two cysteines without asserting non-canonical chemistry', () => {
    expect(unmetDisulfideObjective(record('APDE'))).toContain('0 cysteine residues');
    expect(unmetDisulfideObjective(record('ACD'))).toContain('1 cysteine residues');
  });
  it('does not claim a disulfide bond merely because two cysteines exist', () => {
    expect(unmetDisulfideObjective(record('CAC'))).toBeNull();
    expect(unmetDisulfideObjective(record('APDE', 'Unrelated research question'))).toBeNull();
  });
});
