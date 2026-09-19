import { describe, expect, it } from 'vitest';

import { loadWatcherConfig } from '../src/config.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const KEY = 'ab'.repeat(32);

describe('loadWatcherConfig', () => {
  it('returns defaults with no remotes when nothing is set', () => {
    const cfg = loadWatcherConfig({});
    expect(cfg.remotes).toEqual([]);
    expect(cfg.etica.chainId).toBe(61803);
    expect(cfg.etica.rpcUrl).toBe('https://rpc2.etica-stats.org');
    expect(cfg.heartbeatPrivateKey).toBeUndefined();
    expect(cfg.scanLookbackBlocks).toBe(5_000);
  });

  it('adds a remote only when its minter address is set', () => {
    const cfg = loadWatcherConfig({
      BRIDGE_MINTER_ETH_ADDRESS: ADDR,
      BRIDGE_ETH_RPC_URL: ' https://eth.example ',
    });
    expect(cfg.remotes).toHaveLength(1);
    expect(cfg.remotes[0]).toMatchObject({
      name: 'Ethereum',
      domain: 1,
      chainId: 1,
      minter: ADDR,
      rpcUrl: 'https://eth.example',
    });
  });

  it('configures both remotes with overridable domains', () => {
    const cfg = loadWatcherConfig({
      BRIDGE_MINTER_ETH_ADDRESS: ADDR,
      BRIDGE_MINTER_BNB_ADDRESS: ADDR,
      BRIDGE_BNB_DOMAIN: '5600',
    });
    expect(cfg.remotes.map((r) => r.name)).toEqual(['Ethereum', 'BNB Chain']);
    expect(cfg.remotes[1].domain).toBe(5600);
    expect(cfg.remotes[1].chainId).toBe(56);
  });

  it('normalizes private keys with or without 0x prefix', () => {
    expect(loadWatcherConfig({ BRIDGE_HEARTBEAT_PRIVATE_KEY: KEY }).heartbeatPrivateKey).toBe(`0x${KEY}`);
    expect(loadWatcherConfig({ BRIDGE_EXECUTE_PRIVATE_KEY: `0x${KEY}` }).executePrivateKey).toBe(`0x${KEY}`);
  });

  it('rejects malformed addresses, keys and numbers', () => {
    expect(() => loadWatcherConfig({ BRIDGE_MINTER_ETH_ADDRESS: '0x123' })).toThrow(/valid 0x-prefixed address/);
    expect(() => loadWatcherConfig({ BRIDGE_HEARTBEAT_PRIVATE_KEY: '0xdead' })).toThrow(/32-byte private key/);
    expect(() => loadWatcherConfig({ BRIDGE_SCAN_LOOKBACK_BLOCKS: '-1' })).toThrow(/non-negative number/);
    expect(() => loadWatcherConfig({ BRIDGE_SCAN_LOOKBACK_BLOCKS: 'abc' })).toThrow(/non-negative number/);
  });

  it('treats blank telegram settings as unset', () => {
    const cfg = loadWatcherConfig({ BRIDGE_TELEGRAM_BOT_TOKEN: '  ', BRIDGE_TELEGRAM_CHAT_ID: '' });
    expect(cfg.telegramBotToken).toBeUndefined();
    expect(cfg.telegramChatId).toBeUndefined();
  });
});
