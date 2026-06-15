import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

describe('loadConfig', () => {
  it('applies safe defaults and infers DRY-RUN when no keys are set', () => {
    const c = loadConfig(env());
    expect(c.dryRun).toBe(true);
    expect(c.reserveTopUpBps).toBe(100);
    expect(c.maxSlippageBps).toBe(100);
    expect(c.minPayoutSun).toBe(1_000_000n); // 1 TRX default
    expect(c.initialFrontSun).toBe(0n);
    expect(c.pollIntervalMs).toBe(60_000);
    expect(c.resLockVault).toBeNull();
  });

  it('parses decimal TRX policy fields into SUN', () => {
    const c = loadConfig(env({ WRES_INITIAL_FRONT_TRX: '2.5', WRES_MIN_PAYOUT_TRX: '0.1' }));
    expect(c.initialFrontSun).toBe(2_500_000n);
    expect(c.minPayoutSun).toBe(100_000n);
  });

  it('stays LIVE when a signer key is present', () => {
    const c = loadConfig(env({ WRES_KEEPER_ETICA_PRIVATE_KEY: `0x${'1'.repeat(64)}` }));
    expect(c.dryRun).toBe(false);
  });

  it('honors an explicit WRES_DRY_RUN override even with a key set', () => {
    const c = loadConfig(env({ WRES_KEEPER_ETICA_PRIVATE_KEY: `0x${'1'.repeat(64)}`, WRES_DRY_RUN: 'true' }));
    expect(c.dryRun).toBe(true);
  });

  it('rejects an invalid Etica address', () => {
    expect(() => loadConfig(env({ WRES_RES_LOCK_VAULT_ADDRESS: '0xnope' }))).toThrow(/not a valid address/);
  });

  it('treats the zero address as unset', () => {
    const c = loadConfig(env({ WRES_ETRX_ADDRESS: '0x0000000000000000000000000000000000000000' }));
    expect(c.etrx).toBeNull();
  });

  it('rejects an invalid TRON address', () => {
    expect(() => loadConfig(env({ WRES_WRAPPED_RES_MINER_ADDRESS: 'TX' }))).toThrow(/not a valid TRON address/);
  });

  it('accepts a base58 TRON address', () => {
    const addr = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
    const c = loadConfig(env({ WRES_WRAPPED_RES_MINER_ADDRESS: addr }));
    expect(c.wrappedResMiner).toBe(addr);
  });

  it('rejects a non-hex private key', () => {
    expect(() => loadConfig(env({ WRES_KEEPER_TRON_PRIVATE_KEY: 'deadbeef' }))).toThrow(/0x-prefixed hex/);
  });

  it('rejects out-of-range bps and sub-SUN precision', () => {
    expect(() => loadConfig(env({ WRES_RESERVE_TOPUP_BPS: '10001' }))).toThrow(/cannot exceed 10000/);
    expect(() => loadConfig(env({ WRES_MIN_PAYOUT_TRX: '0.0000001' }))).toThrow(/sub-SUN precision/);
  });
});
