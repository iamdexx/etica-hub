/**
 * Archive-side target grounding.
 *
 * Verification asks whether a design is a real peptide; grounding asks
 * whether the thing it claims to target is a real protein and whether the
 * papers it cites exist. Both are necessary and neither is evidence of
 * binding.
 */

import { groundRun, groundingSummary } from '@etica-hub/shared/labs/grounding';

import type { ArchivedResearch, GroundingRecord } from './archive';

/** Fields that can name a target or cite a paper. */
function groundingTexts(research: ArchivedResearch): string[] {
  return [
    research.goalTitle ?? '',
    research.prompt,
    research.hypothesis,
    research.approach,
    research.successCriteria ?? '',
    ...research.references,
  ].filter(Boolean);
}

/**
 * Resolve the targets and citations of one archived run. Returns null when
 * the lookup fails outright so callers can leave the record ungrounded
 * rather than record a false negative.
 */
export async function groundArchivedResearch(
  research: ArchivedResearch,
): Promise<GroundingRecord | null> {
  try {
    const result = await groundRun(groundingTexts(research));
    return {
      checkedAt: Date.now(),
      summary: groundingSummary(result),
      targets: result.grounded.map((t) => ({
        symbol: t.symbol,
        accession: t.accession,
        entryName: t.entryName,
        proteinName: t.proteinName,
        reviewed: t.reviewed,
      })),
      unresolvedSymbols: result.unresolved,
      citationsFound: result.citationsFound,
      citationsMissing: result.citationsMissing,
    };
  } catch {
    return null;
  }
}
