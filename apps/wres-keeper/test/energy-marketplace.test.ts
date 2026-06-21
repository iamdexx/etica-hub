import { describe, expect, it, vi } from 'vitest';
import { createEnergyMarketplace, type MarketplaceConfig } from '../src/energy-marketplace.js';
import type { BrutusClient, BrutusRates } from '../src/brutus.js';
import { makeLogger } from './fakes.js';

const RATES: BrutusRates = {
  energy_minutes_100K: 4.3,
  energy_hour_100K: 4.8,
  energy_one_day_100K: 6.6,
  energy_over_one_day_100K: 13.5,
  band_minutes_1000: 0.6,
  band_hour_1000: 0.7,
  band_one_day_1000: 0.96,
  band_over_one_day_1000: 1.125,
};

function makeBrutusClient(overrides: Partial<BrutusClient> = {}): BrutusClient {
  return {
    getRates: vi.fn(async () => RATES),
    getAvailability: vi.fn(async () => ({
      av_energy: [],
      av_band: [],
      total_energy_pool: 0,
      total_bandwidth_pool: 0,
    })),
    getBalance: vi.fn(async () => ({
      uses: 0,
      limit: 100000,
      balance: 1000,
      pending_to_collect: 0,
      available_balance: 1000,
    })),
    getPrice: vi.fn(async () => 2.79),
    orderEnergy: vi.fn(async () => ({
      response: 1,
      payment: 2.79,
      tx_id: ['0xabc'],
      balance_left: 997.21,
      requests_left: 99999,
    })),
    orderBandwidth: vi.fn(async () => ({
      response: 1,
      payment: 0.6,
      tx_id: ['0xdef'],
      balance_left: 999.4,
      requests_left: 99998,
    })),
    ...overrides,
  };
}

const MARKETPLACE_CONFIG: MarketplaceConfig = { markupBps: 1500 };

describe('EnergyMarketplace', () => {
  it('quote applies 15% markup to Brutus price', async () => {
    const brutus = makeBrutusClient();
    const marketplace = createEnergyMarketplace(brutus, MARKETPLACE_CONFIG, makeLogger());

    const quote = await marketplace.quote('energy', 32000, '5min');

    expect(quote.brutusCostTrx).toBe(2.79);
    // 2.79 * 1.15 = 3.2085, ceil to SUN precision
    expect(quote.buyerPriceTrx).toBeGreaterThan(2.79);
    expect(quote.buyerPriceTrx).toBeCloseTo(3.2085, 3);
    expect(quote.markupBps).toBe(1500);
    expect(quote.source).toBe('brutus-fallback');
  });

  it('getRates returns both brutus and marked-up rates', async () => {
    const brutus = makeBrutusClient();
    const marketplace = createEnergyMarketplace(brutus, MARKETPLACE_CONFIG, makeLogger());

    const rates = await marketplace.getRates();

    expect(rates.brutus.energy_minutes_100K).toBe(4.3);
    // 4.3 * 1.15 = 4.945
    expect(rates.markup.energy_minutes_100K).toBeGreaterThan(4.3);
    expect(rates.markup.energy_minutes_100K).toBeCloseTo(4.945, 2);
  });

  it('fulfill calls Brutus orderEnergy and returns spread', async () => {
    const brutus = makeBrutusClient();
    const marketplace = createEnergyMarketplace(brutus, MARKETPLACE_CONFIG, makeLogger());

    const result = await marketplace.fulfill('energy', 32000, '5min', 'TBuyer', 'user-1');

    expect(result.source).toBe('brutus-fallback');
    expect(result.brutusCostTrx).toBe(2.79);
    expect(result.buyerPriceTrx).toBeGreaterThan(2.79);
    expect(result.spreadTrx).toBeGreaterThan(0);
    expect(result.txIds).toEqual(['0xabc']);
    expect(brutus.orderEnergy).toHaveBeenCalledWith('TBuyer', 32000, '5min', 'user-1');
  });

  it('fulfill calls Brutus orderBandwidth for bandwidth orders', async () => {
    const brutus = makeBrutusClient({
      getPrice: vi.fn(async () => 0.6),
    });
    const marketplace = createEnergyMarketplace(brutus, MARKETPLACE_CONFIG, makeLogger());

    const result = await marketplace.fulfill('bandwidth', 1000, '5min', 'TBuyer', 'user-2');

    expect(result.resource).toBe('bandwidth');
    expect(result.brutusCostTrx).toBe(0.6);
    expect(result.spreadTrx).toBeGreaterThan(0);
    expect(brutus.orderBandwidth).toHaveBeenCalled();
  });

  it('works with 0% markup (passthrough)', async () => {
    const brutus = makeBrutusClient();
    const marketplace = createEnergyMarketplace(brutus, { markupBps: 0 }, makeLogger());

    const quote = await marketplace.quote('energy', 32000, '5min');

    expect(quote.buyerPriceTrx).toBe(2.79);
    expect(quote.markupBps).toBe(0);
  });

  it('works with 50% markup', async () => {
    const brutus = makeBrutusClient();
    const marketplace = createEnergyMarketplace(brutus, { markupBps: 5000 }, makeLogger());

    const quote = await marketplace.quote('energy', 32000, '5min');

    // 2.79 * 1.5 = 4.185
    expect(quote.buyerPriceTrx).toBeCloseTo(4.185, 3);
  });
});
