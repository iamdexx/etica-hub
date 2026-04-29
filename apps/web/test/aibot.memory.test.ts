import { describe, expect, it } from 'vitest';

import {
  IDLE_TTL_SECONDS,
  MAX_TURNS,
  __testing,
  memoryMemoryStore,
  memoryStoreFor,
} from '../src/lib/aibot/memory';
import type { ChatMessage } from '../src/lib/aibot/llm';

describe('aibot memory store (in-memory backend)', () => {
  it('returns an empty array for an unknown (chat, user) pair', async () => {
    const store = memoryMemoryStore();
    const history = await store.getHistory(-100, 1);
    expect(history).toEqual([]);
  });

  it('persists and retrieves history for a (chat, user) pair', async () => {
    const store = memoryMemoryStore();
    const turns: ChatMessage[] = [
      { role: 'user', content: 'what is TVL?' },
      { role: 'assistant', content: 'TVL is $11.7K' },
    ];
    await store.setHistory(-100, 1, turns);
    const back = await store.getHistory(-100, 1);
    expect(back).toEqual(turns);
  });

  it('isolates history across users in the same chat', async () => {
    const store = memoryMemoryStore();
    await store.setHistory(-100, 1, [{ role: 'user', content: 'A' }]);
    await store.setHistory(-100, 2, [{ role: 'user', content: 'B' }]);
    const a = await store.getHistory(-100, 1);
    const b = await store.getHistory(-100, 2);
    expect(a).toEqual([{ role: 'user', content: 'A' }]);
    expect(b).toEqual([{ role: 'user', content: 'B' }]);
  });

  it('isolates history across chats for the same user', async () => {
    const store = memoryMemoryStore();
    await store.setHistory(-100, 1, [{ role: 'user', content: 'main' }]);
    await store.setHistory(-200, 1, [{ role: 'user', content: 'eticahub' }]);
    const a = await store.getHistory(-100, 1);
    const b = await store.getHistory(-200, 1);
    expect(a[0].content).toBe('main');
    expect(b[0].content).toBe('eticahub');
  });

  it('clearHistory deletes the thread', async () => {
    const store = memoryMemoryStore();
    await store.setHistory(-100, 1, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    expect((await store.getHistory(-100, 1)).length).toBe(2);
    await store.clearHistory(-100, 1);
    expect(await store.getHistory(-100, 1)).toEqual([]);
  });

  it('clearHistory on an empty thread is a no-op', async () => {
    const store = memoryMemoryStore();
    await expect(store.clearHistory(-100, 999)).resolves.toBeUndefined();
  });

  it('does not return more than MAX_TURNS even if storage is over-full', async () => {
    const store = memoryMemoryStore();
    const big: ChatMessage[] = Array.from({ length: MAX_TURNS + 4 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));
    await store.setHistory(-100, 1, big);
    const back = await store.getHistory(-100, 1);
    expect(back).toHaveLength(MAX_TURNS);
    // The oldest turns must be the ones dropped (sliding window).
    expect(back[0].content).toBe(`turn ${big.length - MAX_TURNS}`);
    expect(back[back.length - 1].content).toBe(`turn ${big.length - 1}`);
  });
});

describe('aibot memory store backend selection', () => {
  it('returns null when no KV creds are configured', () => {
    const store = memoryStoreFor({
      kvRestUrl: null,
      kvRestToken: null,
      redisUrl: null,
      kvNamespace: 'aibot:test',
    });
    expect(store).toBeNull();
  });

  it('prefers REST when both REST and Redis are configured', () => {
    const store = memoryStoreFor({
      kvRestUrl: 'https://example-kv.upstash.io',
      kvRestToken: 'token',
      redisUrl: 'redis://localhost:6379',
      kvNamespace: 'aibot:test',
    });
    expect(store).not.toBeNull();
  });
});

describe('aibot memory pruning + decode helpers', () => {
  it('pruneTurns is a no-op below the cap', () => {
    const arr: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    expect(__testing.pruneTurns(arr)).toEqual(arr);
  });

  it('pruneTurns drops oldest turns past MAX_TURNS', () => {
    const arr: ChatMessage[] = Array.from({ length: MAX_TURNS + 2 }, (_, i) => ({
      role: 'user',
      content: `${i}`,
    }));
    const out = __testing.pruneTurns(arr);
    expect(out).toHaveLength(MAX_TURNS);
    expect(out[0].content).toBe('2');
  });

  it('decode returns [] for null / empty / non-JSON / non-array', () => {
    expect(__testing.decode(null)).toEqual([]);
    expect(__testing.decode(undefined)).toEqual([]);
    expect(__testing.decode('')).toEqual([]);
    expect(__testing.decode('not json')).toEqual([]);
    expect(__testing.decode('"a string"')).toEqual([]);
    expect(__testing.decode('{"role":"user"}')).toEqual([]);
  });

  it('decode skips entries that are not valid ChatMessage shapes', () => {
    const raw = JSON.stringify([
      { role: 'user', content: 'kept' },
      { role: 'banana', content: 'dropped' },
      { role: 'assistant' }, // missing content
      { content: 'no role' },
      null,
      'string',
      { role: 'assistant', content: 'kept too' },
    ]);
    expect(__testing.decode(raw)).toEqual([
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'kept too' },
    ]);
  });

  it('decode prunes oversized arrays to MAX_TURNS', () => {
    const big = Array.from({ length: MAX_TURNS + 3 }, (_, i) => ({
      role: 'user',
      content: `${i}`,
    }));
    expect(__testing.decode(JSON.stringify(big))).toHaveLength(MAX_TURNS);
  });

  it('memoryKey scopes by namespace + chat + user', () => {
    expect(__testing.memoryKey('aibot:prod', -100, 7)).toBe('aibot:prod:mem:-100:7');
    expect(__testing.memoryKey('aibot:test', '-100', '7')).toBe('aibot:test:mem:-100:7');
  });
});

describe('aibot memory constants', () => {
  it('caps thread length to a small number of turns', () => {
    expect(MAX_TURNS).toBeGreaterThanOrEqual(4);
    expect(MAX_TURNS).toBeLessThanOrEqual(20);
  });
  it('idle TTL is on the order of half an hour, not days', () => {
    expect(IDLE_TTL_SECONDS).toBeGreaterThanOrEqual(60);
    expect(IDLE_TTL_SECONDS).toBeLessThanOrEqual(3 * 3600);
  });
});
