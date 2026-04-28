/**
 * Conversation-memory store for the Etica AI Telegram bot.
 *
 * Each (chat_id, user_id) pair gets its own short, sliding history of
 * the most recent {@link MAX_TURNS} role-tagged turns (alternating
 * `user` / `assistant`). The history is included in the chat-completion
 * `messages` array so the model can answer follow-up questions
 * coherently — e.g. "and the volume?" right after "what is TVL?".
 *
 * Storage is intentionally narrow:
 *   - One JSON-encoded blob per (chat, user) key.
 *   - {@link IDLE_TTL_SECONDS} TTL is re-anchored on every write, so a
 *     thread expires ~30 minutes after the last activity rather than
 *     accumulating forever.
 *   - {@link MAX_TURNS} cap prunes oldest turns first; history never
 *     grows past it even under heavy use.
 *
 * Two backends are supported (mirroring the quota KV adapter):
 *   - Upstash REST (`AIBOT_KV_REST_URL` / `KV_REST_API_URL`)
 *   - ioredis-compatible TCP Redis (`AIBOT_REDIS_URL` / `REDIS_URL`)
 *
 * When neither is configured, an in-memory store is returned so unit
 * tests and previews still work — they just lose history on restart.
 */

import { Redis } from 'ioredis';

import type { ChatMessage } from './llm';

/** Cap on how many turns we retain per (chat, user). */
export const MAX_TURNS = 6;

/** Idle TTL: history expires this long after the last write. */
export const IDLE_TTL_SECONDS = 30 * 60;

export interface AiBotMemoryStore {
  /** Read the stored history for a (chat, user) pair, oldest-first. Empty when missing. */
  getHistory(chatId: string | number, userId: string | number): Promise<ChatMessage[]>;
  /**
   * Replace the stored history with `history` and re-anchor the TTL.
   * Callers are expected to have already pruned the array to at most
   * {@link MAX_TURNS} turns; this helper does it again defensively so
   * the on-disk blob always satisfies the invariant.
   */
  setHistory(
    chatId: string | number,
    userId: string | number,
    history: ChatMessage[],
  ): Promise<void>;
  /** Delete the stored history. No-op when missing. */
  clearHistory(chatId: string | number, userId: string | number): Promise<void>;
}

interface MemorySource {
  kvRestUrl: string | null;
  kvRestToken: string | null;
  redisUrl: string | null;
  kvNamespace: string;
}

function memoryKey(namespace: string, chatId: string | number, userId: string | number): string {
  return `${namespace}:mem:${chatId}:${userId}`;
}

function pruneTurns(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= MAX_TURNS) return history;
  return history.slice(history.length - MAX_TURNS);
}

function decode(raw: string | null | undefined): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ChatMessage[] = [];
    for (const item of parsed) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'role' in item &&
        'content' in item &&
        typeof (item as { content: unknown }).content === 'string'
      ) {
        const role = (item as { role: unknown }).role;
        if (role === 'user' || role === 'assistant' || role === 'system') {
          out.push({ role, content: (item as { content: string }).content });
        }
      }
    }
    return pruneTurns(out);
  } catch {
    return [];
  }
}

/** Upstash REST adapter — uses GET / SET (with EX) / DEL via fetch only. */
export function restMemoryStore(
  url: string,
  token: string,
  namespace: string,
): AiBotMemoryStore {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };

  return {
    async getHistory(chatId, userId) {
      const key = memoryKey(namespace, chatId, userId);
      const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
        headers,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`aibot-memory get ${key}: ${res.status}`);
      const json = (await res.json()) as { result?: string | null };
      return decode(json.result);
    },
    async setHistory(chatId, userId, history) {
      const key = memoryKey(namespace, chatId, userId);
      const pruned = pruneTurns(history);
      const value = encodeURIComponent(JSON.stringify(pruned));
      // Upstash REST shape: /set/<key>/<value>?EX=<seconds>
      const res = await fetch(
        `${base}/set/${encodeURIComponent(key)}/${value}?EX=${IDLE_TTL_SECONDS}`,
        { method: 'POST', headers },
      );
      if (!res.ok) throw new Error(`aibot-memory set ${key}: ${res.status}`);
    },
    async clearHistory(chatId, userId) {
      const key = memoryKey(namespace, chatId, userId);
      const res = await fetch(`${base}/del/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers,
      });
      if (!res.ok) throw new Error(`aibot-memory del ${key}: ${res.status}`);
    },
  };
}

/** ioredis-backed TCP adapter for `redis://` / `rediss://`. */
const tcpClients = new Map<string, Redis>();

export function tcpMemoryStore(url: string, namespace: string): AiBotMemoryStore {
  let client = tcpClients.get(url);
  if (!client) {
    client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    tcpClients.set(url, client);
  }
  const conn = client;
  return {
    async getHistory(chatId, userId) {
      const raw = await conn.get(memoryKey(namespace, chatId, userId));
      return decode(raw);
    },
    async setHistory(chatId, userId, history) {
      const pruned = pruneTurns(history);
      await conn.set(
        memoryKey(namespace, chatId, userId),
        JSON.stringify(pruned),
        'EX',
        IDLE_TTL_SECONDS,
      );
    },
    async clearHistory(chatId, userId) {
      await conn.del(memoryKey(namespace, chatId, userId));
    },
  };
}

/** In-memory store for tests / preview deployments without Redis. */
export function memoryMemoryStore(namespace = 'aibot:test'): AiBotMemoryStore {
  const m = new Map<string, ChatMessage[]>();
  return {
    async getHistory(chatId, userId) {
      const stored = m.get(memoryKey(namespace, chatId, userId));
      return stored ? pruneTurns([...stored]) : [];
    },
    async setHistory(chatId, userId, history) {
      m.set(memoryKey(namespace, chatId, userId), pruneTurns([...history]));
    },
    async clearHistory(chatId, userId) {
      m.delete(memoryKey(namespace, chatId, userId));
    },
  };
}

/** Pick the memory backend matching the configured KV credentials. */
export function memoryStoreFor(source: MemorySource): AiBotMemoryStore | null {
  if (source.kvRestUrl && source.kvRestToken) {
    return restMemoryStore(source.kvRestUrl, source.kvRestToken, source.kvNamespace);
  }
  if (source.redisUrl) {
    return tcpMemoryStore(source.redisUrl, source.kvNamespace);
  }
  return null;
}

export const __testing = { pruneTurns, decode, memoryKey };
