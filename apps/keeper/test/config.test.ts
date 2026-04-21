import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const REACTOR = '0x1111111111111111111111111111111111111111';

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ORDERBOOK_URL: 'http://api:3100/',
    KEEPER_RPC_URL: 'http://rpc.etica',
    KEEPER_REACTOR_ADDRESS: REACTOR,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('loads required fields + defaults', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.orderbookUrl).toBe('http://api:3100');
    expect(cfg.rpcUrl).toBe('http://rpc.etica');
    expect(cfg.reactor).toBe(REACTOR);
    expect(cfg.chainId).toBe(61803);
    expect(cfg.pollIntervalMs).toBe(5_000);
    expect(cfg.pollBatchSize).toBe(50);
    expect(cfg.deadlineGraceSeconds).toBe(30);
    expect(cfg.keeperAuthToken).toBeNull();
    expect(cfg.keeperPrivateKey).toBeNull();
  });

  it('strips trailing slashes from orderbookUrl', () => {
    expect(loadConfig(baseEnv({ ORDERBOOK_URL: 'http://a///' })).orderbookUrl).toBe('http://a');
  });

  it('throws when ORDERBOOK_URL is missing and no registry address is set', () => {
    expect(() => loadConfig(baseEnv({ ORDERBOOK_URL: undefined }))).toThrow(/ORDERBOOK_URL/);
  });

  it('accepts a registry address as the sole order source', () => {
    const registry = '0x' + '1c'.repeat(20);
    const cfg = loadConfig(
      baseEnv({ ORDERBOOK_URL: undefined, KEEPER_REGISTRY_ADDRESS: registry }),
    );
    expect(cfg.registryAddress?.toLowerCase()).toBe(registry);
    expect(cfg.orderbookUrl).toBeNull();
  });

  it('treats zero-address registry as unset', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          ORDERBOOK_URL: undefined,
          KEEPER_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000000',
        }),
      ),
    ).toThrow(/either KEEPER_REGISTRY_ADDRESS or ORDERBOOK_URL/);
  });

  it('defaults dryRun=true when no private key is set', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.dryRun).toBe(true);
  });

  it('defaults dryRun=false when a private key is set', () => {
    const pk = '0x' + 'ab'.repeat(32);
    const cfg = loadConfig(baseEnv({ KEEPER_PRIVATE_KEY: pk }));
    expect(cfg.dryRun).toBe(false);
  });

  it('KEEPER_DRY_RUN=true wins over the private-key default', () => {
    const pk = '0x' + 'ab'.repeat(32);
    const cfg = loadConfig(baseEnv({ KEEPER_PRIVATE_KEY: pk, KEEPER_DRY_RUN: 'true' }));
    expect(cfg.dryRun).toBe(true);
  });

  it('throws when KEEPER_RPC_URL is missing', () => {
    expect(() => loadConfig(baseEnv({ KEEPER_RPC_URL: undefined }))).toThrow(/KEEPER_RPC_URL/);
  });

  it('throws when KEEPER_REACTOR_ADDRESS is not a valid address', () => {
    expect(() => loadConfig(baseEnv({ KEEPER_REACTOR_ADDRESS: 'nope' }))).toThrow(/address/);
  });

  it('throws when KEEPER_PRIVATE_KEY is not hex', () => {
    expect(() => loadConfig(baseEnv({ KEEPER_PRIVATE_KEY: 'plaintext' }))).toThrow(/hex/);
  });

  it('accepts hex KEEPER_PRIVATE_KEY', () => {
    const pk = '0x' + 'ab'.repeat(32);
    const cfg = loadConfig(baseEnv({ KEEPER_PRIVATE_KEY: pk }));
    expect(cfg.keeperPrivateKey).toBe(pk);
  });

  it('respects overrides for intervals + chain id', () => {
    const cfg = loadConfig(
      baseEnv({
        KEEPER_CHAIN_ID: '1',
        KEEPER_POLL_INTERVAL_MS: '1000',
        KEEPER_POLL_BATCH_SIZE: '200',
        KEEPER_DEADLINE_GRACE_SECONDS: '60',
      }),
    );
    expect(cfg.chainId).toBe(1);
    expect(cfg.pollIntervalMs).toBe(1_000);
    expect(cfg.pollBatchSize).toBe(200);
    expect(cfg.deadlineGraceSeconds).toBe(60);
  });

  it('rejects non-integer numeric overrides', () => {
    expect(() => loadConfig(baseEnv({ KEEPER_POLL_INTERVAL_MS: '3.14' }))).toThrow(/integer/);
    expect(() => loadConfig(baseEnv({ KEEPER_POLL_INTERVAL_MS: '-1' }))).toThrow(/integer/);
    expect(() => loadConfig(baseEnv({ KEEPER_POLL_INTERVAL_MS: 'abc' }))).toThrow(/integer/);
  });

  it('passes through KEEPER_AUTH_TOKEN', () => {
    const cfg = loadConfig(baseEnv({ KEEPER_AUTH_TOKEN: 'secret' }));
    expect(cfg.keeperAuthToken).toBe('secret');
  });
});
