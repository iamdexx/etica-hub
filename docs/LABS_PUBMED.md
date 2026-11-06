# PubMed identifiers and archive backfill

The web and worker planners share ESearch + ESummary validation. Queries use
reviewed UniProt-resolved symbols extracted from the goal, or the original goal
when none resolve. These are **background searches**, not proof of claim support.
Each selected PMID must have its own matching UID and nonblank title in ESummary.
Lookup outages and malformed responses throw; they are not fabricated citations.
Calls are paced below three/second **per process**; avoid parallel backfill runs.

Planner references retain their query, lookup timestamp and canonical metadata
in `referenceProvenance`. A model can still make unsupported claims: identifier
verification is not scientific validation. Existing publication requirements
remain in force and citation metadata is also required. No medical, binding,
safety or efficacy evidence is inferred.

## Retrospective backfill

Run from the repository root with the existing workspace dependencies. Set
`REDIS_URL` securely to the intended Labs archive, and choose a persistent,
private `BACKFILL_DIR` outside the repository. Never commit its contents.

```sh
# Preview five records, without changing Redis.
BACKFILL_LIMIT=5 pnpm --filter @etica-hub/labs-autopilot exec \
  tsx ../../apps/web/scripts/backfill-pubmed.ts

# Apply to the snapshot; omit BACKFILL_LIMIT for all records.
pnpm --filter @etica-hub/labs-autopilot exec \
  tsx ../../apps/web/scripts/backfill-pubmed.ts --apply
```

- `ids.json` fixes the record set so new archives cannot shift pagination.
- `before.jsonl` stores and fsyncs the original record before each write.
- Writes compare the entire original value atomically in Redis; concurrent edits
  are skipped, never overwritten. TTLs are retained.
- Re-running with the same directory skips saved IDs and retries failed ones.
  `BACKFILL_LIMIT` limits newly processed records, not the snapshot size.
- Original references, candidate data, grades and claims are never replaced.
  Only citation resolution is refreshed; target checks keep their original date.
- Retrospective searches use the record's reviewed target symbols and disease.
  Results go into `literatureContext` with `relation: background-only`, never
  `references` or `grounding.citationsFound`. They cannot make a draft publishable.
- `dry-run.jsonl` / `applied.jsonl` record each decision and lookup errors.
  `totals.json` reports the actual stored snapshot, not dry-run projections.
  A nonzero exit status requires inspecting errors and retrying.
- No announcements, NFTs or new research jobs are created. Publication decisions
  are recomputed by the normal publication function, not a separate score.
- Backups are for selective recovery: never blindly replay complete old records
  over newer minting, editorial or verification updates.

The new background-literature panel needs the web deployment; the stored field
is already included in archive JSON. Existing readers ignore it for publication.
