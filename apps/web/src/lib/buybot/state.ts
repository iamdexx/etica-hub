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
