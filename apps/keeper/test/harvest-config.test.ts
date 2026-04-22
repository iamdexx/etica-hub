import { describe, it, expect } from 'vitest';
import { loadHarvestConfig } from '../src/harvest/config.js';

const BASE: NodeJS.ProcessEnv = {
  HARVEST_RPC_URL: 'https://rpc',
  HARVEST_TREASURY_ADDRESS: '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D',
  HARVEST_ETX_ADDRESS: '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044',
  HARVEST_ETI_ADDRESS: '0x34c61EA91bAcdA647269d4e310A86b875c09946f',
  HARVEST_WEGAZ_ADDRESS: '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a',
  HARVEST_ROUTER_ADDRESS: '0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723',
  HARVEST_FACTORY_ADDRESS: '0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3',
};

describe('loadHarvestConfig', () => {
  it('uses default 10/10/40/40 split', () => {
    const cfg = loadHarvestConfig(BASE);
    expect(cfg.split.stakedEtxBps).toBe(1000);
    expect(cfg.split.farmsBps).toBe(1000);
    expect(cfg.split.polBurnBps).toBe(4000);
    expect(cfg.split.treasuryBps).toBe(4000);
  });

  it('defaults to dryRun=true when no key', () => {
    const cfg = loadHarvestConfig(BASE);
    expect(cfg.dryRun).toBe(true);
  });

  it('defaults to dryRun=false when key is set', () => {
    const cfg = loadHarvestConfig({
      ...BASE,
      HARVEST_PRIVATE_KEY: '0x' + '11'.repeat(32),
    });
    expect(cfg.dryRun).toBe(false);
  });

  it('rejects a split that does not sum to 10000', () => {
    expect(() =>
      loadHarvestConfig({
        ...BASE,
        HARVEST_STAKED_ETX_BPS: '2000',
        HARVEST_FARMS_BPS: '1000',
        HARVEST_POL_BURN_BPS: '4000',
        HARVEST_TREASURY_BPS: '4000', // sum = 11000
      }),
    ).toThrow(/must sum to 10000/);
  });

  it('accepts an explicit 25/10/30/35 split', () => {
    const cfg = loadHarvestConfig({
      ...BASE,
      HARVEST_STAKED_ETX_BPS: '2500',
      HARVEST_FARMS_BPS: '1000',
      HARVEST_POL_BURN_BPS: '3000',
      HARVEST_TREASURY_BPS: '3500',
    });
    expect(cfg.split.stakedEtxBps).toBe(2500);
    expect(cfg.split.polBurnBps).toBe(3000);
  });

  it('rejects burn-per-run of 0', () => {
    expect(() =>
      loadHarvestConfig({ ...BASE, HARVEST_BURN_BPS_PER_RUN: '0' }),
    ).toThrow(/HARVEST_BURN_BPS_PER_RUN/);
  });

  it('rejects invalid POL weighting', () => {
    expect(() =>
      loadHarvestConfig({ ...BASE, HARVEST_POL_WEIGHTING: 'volume_7d' }),
    ).toThrow(/HARVEST_POL_WEIGHTING/);
  });

  it('treats zero address as not-deployed for optional vaults', () => {
    const cfg = loadHarvestConfig({
      ...BASE,
      HARVEST_STAKED_ETX_ADDRESS: '0x0000000000000000000000000000000000000000',
      HARVEST_FARMS_ADDRESS: '0x0000000000000000000000000000000000000000',
    });
    expect(cfg.stakedEtx).toBeNull();
    expect(cfg.farms).toBeNull();
  });
});
