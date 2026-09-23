/**
 * One-off audit: grade every published EticaHub Labs candidate with the
 * objective verifier, straight from the public archive API.
 *
 *   pnpm --filter @etica-hub/web exec tsx scripts/audit-archive.ts [baseUrl]
 */

import { verifyCandidate } from '@etica-hub/shared/labs/verify';

const base = process.argv[2] ?? 'https://eticahub.com';

interface Candidate {
  index: number;
  sequence: string;
  score?: number;
  folded?: boolean;
}
interface Record_ {
  id: string;
  disease?: string;
  goalTitle?: string;
  bestCandidate: Candidate;
  candidates: Candidate[];
  bestPdb?: string;
}

async function main() {
  const records: Record_[] = [];
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${base}/api/labs/archive?limit=100&offset=${offset}`);
    if (!res.ok) throw new Error(`archive ${res.status}`);
    const page = (await res.json()) as { results: Record_[]; total: number };
    records.push(...page.results);
    if (records.length >= page.total || page.results.length === 0) break;
  }

  const gradeCount = { verified: 0, weak: 0, rejected: 0 };
  const bestGradeCount = { verified: 0, weak: 0, rejected: 0 };
  let candidates = 0;
  let wouldReRank = 0;
  const failReasons = new Map<string, number>();

  for (const r of records) {
    const all = r.candidates?.length ? r.candidates : [r.bestCandidate].filter(Boolean);
    const results = all.map((c) =>
      verifyCandidate({
        sequence: c.sequence,
        pdb: c.sequence === r.bestCandidate?.sequence ? r.bestPdb : undefined,
        folded: c.folded,
        peers: all.filter((o) => o.index !== c.index).map((o) => o.sequence),
      }),
    );
    results.forEach((res, i) => {
      candidates += 1;
      gradeCount[res.grade] += 1;
      for (const check of res.checks) {
        if (check.status === 'fail') {
          failReasons.set(check.label, (failReasons.get(check.label) ?? 0) + 1);
        }
      }
      if (all[i]!.index === r.bestCandidate?.index) bestGradeCount[res.grade] += 1;
    });
    const adjusted = all.map((c, i) => (c.score ?? 0) * results[i]!.penalty);
    let bestIdx = 0;
    adjusted.forEach((v, i) => {
      if (v > adjusted[bestIdx]!) bestIdx = i;
    });
    if (all[bestIdx]!.index !== r.bestCandidate?.index) wouldReRank += 1;
  }

  const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
  console.log(`records: ${records.length}, candidates: ${candidates}`);
  console.log('all candidates:');
  for (const [k, v] of Object.entries(gradeCount)) console.log(`  ${k}: ${v} (${pct(v, candidates)})`);
  console.log('published best candidates:');
  for (const [k, v] of Object.entries(bestGradeCount)) {
    console.log(`  ${k}: ${v} (${pct(v, records.length)})`);
  }
  console.log(`runs whose headline result would change: ${wouldReRank} (${pct(wouldReRank, records.length)})`);
  console.log('hard-fail reasons:');
  for (const [k, v] of [...failReasons].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
