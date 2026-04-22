import { describe, expect, it } from 'vitest';
import {
  lastBlockKey,
  memoryKv,
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
    expect(bad.minUsdToPost).toBe(1);
    expect(bad.maxBlocksPerRun).toBe(2000);
  });

  it('rejects invalid address overrides', () => {
    expect(() => cfg({ BUYBOT_FACTORY: '0xnotanaddress' })).toThrow(/not a valid EVM address/);
  });
});
