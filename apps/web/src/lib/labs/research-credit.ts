import type { ArchivedResearch } from './archive';
import type { LabsGoal } from './goal';
import { getGoal } from './goal-store';

export type ResearchCredit =
  | { kind: 'eticahub'; name: 'Deaven Mabry'; affiliation: 'EticaHub Labs'; rootGoalId: string }
  | { kind: 'community'; name: string }
  | { kind: 'unknown'; name: 'Creator not established' };

const UNKNOWN: ResearchCredit = { kind: 'unknown', name: 'Creator not established' };
export const LABS_DATA_LICENSE = 'https://creativecommons.org/licenses/by/4.0/';

type CreditGoal = Pick<LabsGoal, 'submitterTag' | 'submitterWallet' | 'parentGoalId'>;

function walletCredit(wallet: string): ResearchCredit {
  return /^0x[0-9a-fA-F]{40}$/.test(wallet) ? { kind: 'community', name: wallet } : UNKNOWN;
}

export async function researchCredit(
  record: Pick<ArchivedResearch, 'submitterWallet' | 'goalId'>,
  loadGoal: (id: string) => Promise<CreditGoal | null> = getGoal,
): Promise<ResearchCredit> {
  if (record.submitterWallet) return walletCredit(record.submitterWallet);
  const seen = new Set<string>();
  let id = record.goalId;
  while (id && !seen.has(id) && seen.size < 64) {
    seen.add(id);
    const goal = await loadGoal(id);
    if (!goal) return UNKNOWN;
    if (goal.submitterWallet) return walletCredit(goal.submitterWallet);
    if (goal.parentGoalId) {
      id = goal.parentGoalId;
      continue;
    }
    return goal.submitterTag === 'autopilot-seed'
      ? { kind: 'eticahub', name: 'Deaven Mabry', affiliation: 'EticaHub Labs', rootGoalId: id }
      : UNKNOWN;
  }
  return UNKNOWN;
}

export function researchCreditMetadata(credit: ResearchCredit) {
  if (credit.kind === 'unknown') return {};
  return {
    creator: {
      '@type': 'Person',
      name: credit.name,
      ...(credit.kind === 'eticahub'
        ? { affiliation: { '@type': 'Organization', name: credit.affiliation } }
        : {}),
    },
    ...(credit.kind === 'eticahub' ? { license: LABS_DATA_LICENSE } : {}),
  };
}

export function unmetDisulfideObjective(record: ArchivedResearch): string | null {
  const objective = [record.prompt, record.hypothesis, record.approach, record.successCriteria]
    .filter(Boolean)
    .join(' ');
  const cysteines = record.bestCandidate.sequence.match(/C/g)?.length ?? 0;
  if (!/disulfide/i.test(objective) || cysteines >= 2) return null;
  return `The pipeline-selected candidate has ${cysteines} cysteine residues. Its recorded sequence cannot form an intramolecular cysteine disulfide bridge; the proposed disulfide-stapling objective is not demonstrated. A non-canonical crosslink is not established by sequence alone.`;
}
