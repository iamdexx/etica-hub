import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import {
  pubmedTargetQuery,
  searchPubmed,
  type PubmedLiterature,
} from '@etica-hub/shared/labs/grounding';
import type { ArchivedResearch } from '../src/lib/labs/archive';
import { recheckArchivedCitations } from '../src/lib/labs/grounding';
import { publicationDecision } from '../src/lib/labs/publication';

const apply = process.argv.includes('--apply');
const runDir = process.env.BACKFILL_DIR;
if (!runDir || !process.env.REDIS_URL) throw new Error('Set BACKFILL_DIR and REDIS_URL');
mkdirSync(runDir, { recursive: true, mode: 0o700 });
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
const searches = new Map<string, PubmedLiterature>();
const cas = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL'); return 1`;

async function run() {
  const snapshotFile = path.join(runDir!, 'ids.json');
  const ids: string[] = existsSync(snapshotFile)
    ? JSON.parse(readFileSync(snapshotFile, 'utf8'))
    : await redis.zrevrange('labs:archive:index', 0, -1);
  if (!existsSync(snapshotFile))
    writeFileSync(snapshotFile, JSON.stringify(ids), { mode: 0o600, flag: 'wx' });
  const journal = path.join(runDir!, apply ? 'applied.jsonl' : 'dry-run.jsonl');
  const done = new Set<string>(
    existsSync(journal)
      ? readFileSync(journal, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { id: string; outcome: string })
          .filter((r) => r.outcome === 'saved')
          .map((r) => r.id)
      : [],
  );
  const limit = Number(process.env.BACKFILL_LIMIT ?? ids.length);
  let processed = 0;
  let errors = 0;
  for (const id of ids) {
    if (done.has(id)) continue;
    if (processed >= limit) break;
    const key = `labs:archive:${id}`;
    const raw = await redis.get(key);
    if (!raw) {
      errors++;
      continue;
    }
    try {
      const record = JSON.parse(raw) as ArchivedResearch;
      const grounding = await recheckArchivedCitations(record);
      if (!grounding) throw new Error('Target lookup unavailable; record unchanged');
      const updated: ArchivedResearch = { ...record, grounding };
      const query = pubmedTargetQuery(
        grounding.targets.filter((t) => t.reviewed).map((t) => t.symbol),
        record.disease,
      );
      let backgroundError: string | undefined;
      if (query) {
        let literature = searches.get(query);
        if (!literature) {
          try {
            literature = await searchPubmed(query, 3);
            searches.set(query, literature);
          } catch (error) {
            backgroundError = String(error);
          }
        }
        if (literature) updated.literatureContext = { ...literature, relation: 'background-only' };
      }
      const decision = publicationDecision(updated);
      let outcome = 'dry-run';
      if (apply) {
        appendFileSync(path.join(runDir!, 'before.jsonl'), `${JSON.stringify({ id, raw })}\n`, {
          mode: 0o600,
          flush: true,
        });
        if ((await redis.eval(cas, 1, key, raw, JSON.stringify(updated))) !== 1) {
          throw new Error('Concurrent edit; record unchanged');
        }
        outcome = backgroundError ? 'saved-partial' : 'saved';
      }
      appendFileSync(
        journal,
        `${JSON.stringify({
          id,
          outcome,
          decision,
          citations: grounding.citationsFound.length,
          missing: grounding.citationsMissing,
          background: updated.literatureContext?.citations.length ?? 0,
          backgroundError,
        })}\n`,
        { mode: 0o600, flush: true },
      );
    } catch (error) {
      errors++;
      appendFileSync(
        journal,
        `${JSON.stringify({ id, outcome: 'error', error: String(error) })}\n`,
        { mode: 0o600, flush: true },
      );
    }
    processed++;
    if (processed % 25 === 0) console.log(JSON.stringify({ processed, total: ids.length, errors }));
  }
  const totals = {
    snapshot: ids.length,
    read: 0,
    published: 0,
    draft: 0,
    verified: 0,
    weak: 0,
    rejected: 0,
    ungraded: 0,
    withCitations: 0,
    withBackground: 0,
    missingCitations: 0,
    errors,
    processed,
    apply,
  };
  for (const id of ids) {
    const raw = await redis.get(`labs:archive:${id}`);
    if (!raw) continue;
    const record = JSON.parse(raw) as ArchivedResearch;
    totals.read++;
    totals[publicationDecision(record).status]++;
    totals[record.bestCandidate.verification?.grade ?? 'ungraded']++;
    if (record.grounding?.citationsFound.length) totals.withCitations++;
    if (record.grounding?.citationsMissing.length) totals.missingCitations++;
    if (record.literatureContext?.citations.length) totals.withBackground++;
  }
  writeFileSync(path.join(runDir!, 'totals.json'), JSON.stringify(totals, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(totals));
  if (errors) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => redis.disconnect());
