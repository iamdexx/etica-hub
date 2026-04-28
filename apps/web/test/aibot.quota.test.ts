import { describe, expect, it } from 'vitest';
import { memoryAiBotKv } from '../src/lib/aibot/kv';
import { readQuota, recordUsage, utcDateKey } from '../src/lib/aibot/quota';

const NS = 'aibot:test';

describe('aibot quota', () => {
  it('reports zero counters and no caps hit when no kv is configured', async () => {
    const q = await readQuota({
      kv: null,
      namespace: NS,
      chatId: -1001,
      chatDailyCap: 1000,
      dailyUsdCap: 5,
    });
    expect(q.chatCount).toBe(0);
    expect(q.usdSpent).toBe(0);
    expect(q.anyCapHit).toBe(false);
  });

  it('records each call against the per-chat counter', async () => {
    const kv = memoryAiBotKv();
    for (let i = 0; i < 3; i++) {
      await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 0 });
    }
    const q = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 1000,
      dailyUsdCap: 5,
    });
    expect(q.chatCount).toBe(3);
    expect(q.usdSpent).toBe(0);
    expect(q.anyCapHit).toBe(false);
  });

  it('isolates counters across chats', async () => {
    const kv = memoryAiBotKv();
    await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 0 });
    await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 0 });
    await recordUsage({ kv, namespace: NS, chatId: -200, costUsd: 0 });

    const a = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 1000,
      dailyUsdCap: 5,
    });
    const b = await readQuota({
      kv,
      namespace: NS,
      chatId: -200,
      chatDailyCap: 1000,
      dailyUsdCap: 5,
    });
    expect(a.chatCount).toBe(2);
    expect(b.chatCount).toBe(1);
  });

  it('flags chatCapHit once the per-chat cap is reached', async () => {
    const kv = memoryAiBotKv();
    for (let i = 0; i < 5; i++) {
      await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 0 });
    }
    const q = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 5,
      dailyUsdCap: 5,
    });
    expect(q.chatCapHit).toBe(true);
    expect(q.usdCapHit).toBe(false);
    expect(q.anyCapHit).toBe(true);
  });

  it('flags usdCapHit once cumulative cost exceeds the USD cap', async () => {
    const kv = memoryAiBotKv();
    for (let i = 0; i < 4; i++) {
      await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 1.5 });
    }
    const q = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 1000,
      dailyUsdCap: 5,
    });
    expect(q.usdSpent).toBeCloseTo(6, 5);
    expect(q.usdCapHit).toBe(true);
    expect(q.chatCapHit).toBe(false);
    expect(q.anyCapHit).toBe(true);
  });

  it('skips USD writes when cost is 0 (free-tier providers)', async () => {
    const kv = memoryAiBotKv();
    await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 0 });
    const q = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 1000,
      dailyUsdCap: 5,
    });
    expect(q.usdSpent).toBe(0);
    expect(q.chatCount).toBe(1);
  });

  it('treats zero cap as unlimited', async () => {
    const kv = memoryAiBotKv();
    for (let i = 0; i < 50; i++) {
      await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 1.0 });
    }
    const q = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 0,
      dailyUsdCap: 0,
    });
    expect(q.anyCapHit).toBe(false);
  });

  it('utcDateKey returns YYYY-MM-DD', () => {
    const d = new Date('2026-04-19T18:00:00Z');
    expect(utcDateKey(d)).toBe('2026-04-19');
  });

  it('keys are scoped by UTC date so a counter resets at midnight', async () => {
    const kv = memoryAiBotKv();
    const day1 = new Date('2026-04-19T23:30:00Z');
    const day2 = new Date('2026-04-20T00:30:00Z');

    await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 0, now: day1 });
    await recordUsage({ kv, namespace: NS, chatId: -100, costUsd: 0, now: day1 });

    const before = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 100,
      dailyUsdCap: 5,
      now: day1,
    });
    expect(before.chatCount).toBe(2);

    const after = await readQuota({
      kv,
      namespace: NS,
      chatId: -100,
      chatDailyCap: 100,
      dailyUsdCap: 5,
      now: day2,
    });
    expect(after.chatCount).toBe(0);
  });
});
