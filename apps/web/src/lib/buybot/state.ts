/**
 * Tiny persistent state for the buy bot.
 *
 * Vercel crons are stateless between invocations, so the bot keeps
 * `lastScannedBlock` in Upstash Redis (or any Redis-REST-compatible store
 * such as Vercel KV). The key is namespaced by {@link BuyBotConfig.kvNamespace}
 * so multiple deployments (preview / production) don't stomp on each other.
 *
 * When no KV credentials are configured we fall back to rescanning the most
 * recent `fallbackLookbackBlocks` blocks every run and relying on an
 * in-process dedup keyed by `{txHash}:{logIndex}`. That's fine for local dev
 * and single-run tests but would cause duplicate posts if enabled in
 * production, so `/api/cron/buybot` refuses to run in production without KV.
 */

import type { BuyBotConfig } from './config';

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /**
   * SET with NX + EX semantics: writes `value` at `key` only if `key` does
   * not exist, with a `ttlSeconds` expiry. Returns `true` if the write
   * happened (key was new), `false` if the key already existed.
   */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * Upstash-compatible REST KV driver.
 *
 * Uses only `fetch` so we don't pull in `@upstash/redis` as a dependency; the
 * REST contract is stable and exposed identically by Vercel KV.
 */
export function restKv(url: string, token: string): KvStore {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };
  return {
    async get(key) {
      const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
        headers,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`kv get ${key}: ${res.status}`);
      const json = (await res.json()) as { result?: string | null };
      return json.result ?? null;
    },
    async set(key, value) {
      const res = await fetch(
        `${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,
        { method: 'POST', headers },
      );
      if (!res.ok) throw new Error(`kv set ${key}: ${res.status}`);
    },
    async setIfAbsent(key, value, ttlSeconds) {
      // Upstash REST: `SET key value EX <ttl> NX` expressed as path segments.
      // Responds with `{"result":"OK"}` on write, `{"result":null}` if the
      // key already existed and NX prevented the overwrite.
      const path = `${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${ttlSeconds}/NX`;
      const res = await fetch(path, { method: 'POST', headers });
      if (!res.ok) throw new Error(`kv setIfAbsent ${key}: ${res.status}`);
      const json = (await res.json()) as { result?: string | null };
      return json.result === 'OK';
    },
  };
}

/** In-memory KV used for unit tests and missing-credential fallback. */
export function memoryKv(seed: Record<string, string> = {}): KvStore {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    async get(key) {
      return m.get(key) ?? null;
    },
    async set(key, value) {
      m.set(key, value);
    },
    async setIfAbsent(key, value) {
      if (m.has(key)) return false;
      m.set(key, value);
      return true;
    },
  };
}

export function kvFor(config: BuyBotConfig): KvStore | null {
  if (!config.kvRestUrl || !config.kvRestToken) return null;
  return restKv(config.kvRestUrl, config.kvRestToken);
}

/** Last-scanned block key, namespaced by deployment. */
export function lastBlockKey(config: BuyBotConfig): string {
  return `${config.kvNamespace}:lastBlock`;
}

export async function readLastScannedBlock(
  kv: KvStore,
  config: BuyBotConfig,
): Promise<bigint | null> {
  const raw = await kv.get(lastBlockKey(config));
  if (!raw) return null;
  try {
    const n = BigInt(raw);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

export async function writeLastScannedBlock(
  kv: KvStore,
  config: BuyBotConfig,
  value: bigint,
): Promise<void> {
  await kv.set(lastBlockKey(config), value.toString());
}

/** 24h — long enough to ride out any transient KV-write failure + retry. */
export const POSTED_TTL_SECONDS = 24 * 60 * 60;

export function postedKey(
  config: BuyBotConfig,
  txHash: string,
  logIndex: number,
): string {
  return `${config.kvNamespace}:posted:${txHash.toLowerCase()}:${logIndex}`;
}

/**
 * Atomically claim a `(txHash, logIndex)` as posted. Returns `true` if this
 * call was the first to claim it (caller should post to Telegram), `false`
 * if another run already posted this swap (caller should skip).
 *
 * This is the safety net against the classic at-least-once cron hazard: if
 * `writeLastScannedBlock` fails after we've already sent Telegram messages,
 * the next run would rescan the same range — without this, every buy in that
 * range posts twice.
 */
export async function claimBuyPost(
  kv: KvStore,
  config: BuyBotConfig,
  txHash: string,
  logIndex: number,
): Promise<boolean> {
  return kv.setIfAbsent(postedKey(config, txHash, logIndex), '1', POSTED_TTL_SECONDS);
}
