import { describe, expect, it } from 'vitest';
import {
  claimBuyPost,
  lastBlockKey,
  memoryKv,
  postedKey,
  readLastScannedBlock,
  writeLastScannedBlock,
} from '../src/lib/buybot/state';
import { loadBuyBotConfig } from '../src/lib/buybot/config';

function cfg(overrides: NodeJS.ProcessEnv = {}): ReturnType<typeof loadBuyBotConfig> {
  const base: NodeJS.ProcessEnv = {
    BUYBOT_TELEGRAM_BOT_TOKEN: 'x',
    BUYBOT_TELEGRAM_CHAT_ID: 'y',
    BUYBOT_RPC_URL: 'https://rpc.example',
    BUYBOT_CHAIN_ID: '61803',
    BUYBOT_KV_NAMESPACE: 'test:buybot',
    ...overrides,
  };
  return loadBuyBotConfig(base);
}

describe('buybot state (memoryKv)', () => {
  it('returns null when no cursor has been written', async () => {
    const kv = memoryKv();
    const v = await readLastScannedBlock(kv, cfg());
    expect(v).toBeNull();
  });

  it('round-trips a bigint cursor via the KV driver', async () => {
    const kv = memoryKv();
    await writeLastScannedBlock(kv, cfg(), 12_345n);
    const v = await readLastScannedBlock(kv, cfg());
    expect(v).toBe(12_345n);
  });

  it('namespaces the key so preview + production deploys do not collide', () => {
    expect(lastBlockKey(cfg({ BUYBOT_KV_NAMESPACE: 'a' }))).toBe('a:lastBlock');
    expect(lastBlockKey(cfg({ BUYBOT_KV_NAMESPACE: 'b' }))).toBe('b:lastBlock');
  });

  it('gracefully returns null on corrupted cursor values', async () => {
    const kv = memoryKv({ 'test:buybot:lastBlock': 'not-a-number' });
    const v = await readLastScannedBlock(kv, cfg());
    expect(v).toBeNull();
  });
});

describe('buybot dedup (claimBuyPost)', () => {
  const tx = '0xABCDEF0000000000000000000000000000000000000000000000000000000001' as const;

  it('namespaces and lowercases the posted key', () => {
    expect(postedKey(cfg({ BUYBOT_KV_NAMESPACE: 'ns' }), tx, 7)).toBe(
      'ns:posted:0xabcdef0000000000000000000000000000000000000000000000000000000001:7',
    );
  });

  it('returns true on first claim and false on subsequent claims of the same swap', async () => {
    const kv = memoryKv();
    const first = await claimBuyPost(kv, cfg(), tx, 5);
    const second = await claimBuyPost(kv, cfg(), tx, 5);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('treats different log indices in the same tx as independent', async () => {
    const kv = memoryKv();
    expect(await claimBuyPost(kv, cfg(), tx, 1)).toBe(true);
    expect(await claimBuyPost(kv, cfg(), tx, 2)).toBe(true);
    expect(await claimBuyPost(kv, cfg(), tx, 1)).toBe(false);
  });

  it('is case-insensitive on tx hash so mixed-case inputs still dedup', async () => {
    const kv = memoryKv();
    expect(await claimBuyPost(kv, cfg(), tx.toUpperCase(), 3)).toBe(true);
    expect(await claimBuyPost(kv, cfg(), tx.toLowerCase(), 3)).toBe(false);
  });
});

describe('restKv.setIfAbsent', () => {
  it('returns true when Upstash responds result=OK', async () => {
    const originalFetch = globalThis.fetch;
    const capturedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrls.push(String(input));
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }) as typeof fetch;
    try {
      const { restKv } = await import('../src/lib/buybot/state');
      const kv = restKv('https://kv.example', 'tok');
      const ok = await kv.setIfAbsent('k', 'v', 60);
      expect(ok).toBe(true);
      expect(capturedUrls[0]).toContain('/set/k/v/EX/60/NX');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns false when Upstash responds result=null (key already existed)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: null }), { status: 200 })) as typeof fetch;
    try {
      const { restKv } = await import('../src/lib/buybot/state');
      const kv = restKv('https://kv.example', 'tok');
      expect(await kv.setIfAbsent('k', 'v', 60)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('loadBuyBotConfig', () => {
  it('flips enabled=false when required secrets are missing', () => {
    const c = loadBuyBotConfig({ BUYBOT_CHAIN_ID: '61803' });
    expect(c.enabled).toBe(false);
  });

  it('parses minUsd and maxBlocks knobs, rejecting bad values', () => {
    const c = cfg({
      BUYBOT_MIN_USD_TO_POST: '2.5',
      BUYBOT_MAX_BLOCKS_PER_RUN: '500',
    });
    expect(c.minUsdToPost).toBe(2.5);
    expect(c.maxBlocksPerRun).toBe(500);

    const bad = cfg({
      BUYBOT_MIN_USD_TO_POST: 'nope',
      BUYBOT_MAX_BLOCKS_PER_RUN: '-1',
    });
    expect(bad.minUsdToPost).toBe(0.1);
    expect(bad.maxBlocksPerRun).toBe(2000);
  });

  it('rejects invalid address overrides', () => {
    expect(() => cfg({ BUYBOT_FACTORY: '0xnotanaddress' })).toThrow(/not a valid EVM address/);
  });
});
