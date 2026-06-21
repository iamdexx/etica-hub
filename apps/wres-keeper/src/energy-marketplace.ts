/**
 * Energy Marketplace — sell energy & bandwidth to buyers.
 *
 * Pricing strategy:
 *   1. If our own pool has capacity → sell at our own rate (Brutus rate × markup).
 *   2. If our pool is tapped out  → fulfil via Brutus API at Brutus rate + 15%.
 *
 * The buyer always pays the same price (Brutus rate × markup). Whether we
 * source internally (higher margin) or via Brutus (15% spread) is transparent
 * to them.
 */

import type {
  BrutusClient,
  BrutusRates,
  ResourceType,
  RentalDuration,
} from './brutus.js';
import type { Logger } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketplaceConfig {
  markupBps: number; // default 1500 = 15%
}

export interface QuoteResult {
  resource: ResourceType;
  amount: number;
  duration: RentalDuration;
  brutusCostTrx: number;
  buyerPriceTrx: number;
  markupBps: number;
  source: 'own-pool' | 'brutus-fallback';
}

export interface FulfillResult {
  resource: ResourceType;
  amount: number;
  duration: RentalDuration;
  source: 'own-pool' | 'brutus-fallback';
  brutusCostTrx: number;
  buyerPriceTrx: number;
  spreadTrx: number;
  txIds: string[];
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

export interface EnergyMarketplace {
  quote(resource: ResourceType, amount: number, duration: RentalDuration): Promise<QuoteResult>;
  getRates(): Promise<{ brutus: BrutusRates; markup: BrutusRates }>;
  fulfill(
    resource: ResourceType,
    amount: number,
    duration: RentalDuration,
    buyerWallet: string,
    userId: string,
  ): Promise<FulfillResult>;
}

export function createEnergyMarketplace(
  brutus: BrutusClient,
  config: MarketplaceConfig,
  log: Logger,
): EnergyMarketplace {
  const multiplier = (10_000 + config.markupBps) / 10_000;

  function applyMarkup(trx: number): number {
    return Math.ceil(trx * multiplier * 1e6) / 1e6; // round up to 6 decimals (SUN precision)
  }

  function applyMarkupToRates(rates: BrutusRates): BrutusRates {
    return {
      energy_minutes_100K: applyMarkup(rates.energy_minutes_100K),
      energy_hour_100K: applyMarkup(rates.energy_hour_100K),
      energy_one_day_100K: applyMarkup(rates.energy_one_day_100K),
      energy_over_one_day_100K: applyMarkup(rates.energy_over_one_day_100K),
      band_minutes_1000: applyMarkup(rates.band_minutes_1000),
      band_hour_1000: applyMarkup(rates.band_hour_1000),
      band_one_day_1000: applyMarkup(rates.band_one_day_1000),
      band_over_one_day_1000: applyMarkup(rates.band_over_one_day_1000),
    };
  }

  async function getRates(): Promise<{ brutus: BrutusRates; markup: BrutusRates }> {
    const brutusRates = await brutus.getRates();
    return { brutus: brutusRates, markup: applyMarkupToRates(brutusRates) };
  }

  async function quote(
    resource: ResourceType,
    amount: number,
    duration: RentalDuration,
  ): Promise<QuoteResult> {
    const brutusCostTrx = await brutus.getPrice(resource, amount, duration);
    const buyerPriceTrx = applyMarkup(brutusCostTrx);

    // For now, all orders go through Brutus as fallback since we don't have
    // our own delegation pool wired yet. When the own-pool is implemented,
    // check capacity first and set source accordingly.
    const source = 'brutus-fallback' as const;

    log.info(
      `[marketplace] quote: ${resource} ${amount} for ${duration} — ` +
        `brutus=${brutusCostTrx} TRX, buyer=${buyerPriceTrx} TRX (+${config.markupBps / 100}%)`,
    );

    return {
      resource,
      amount,
      duration,
      brutusCostTrx,
      buyerPriceTrx,
      markupBps: config.markupBps,
      source,
    };
  }

  async function fulfill(
    resource: ResourceType,
    amount: number,
    duration: RentalDuration,
    buyerWallet: string,
    userId: string,
  ): Promise<FulfillResult> {
    const quoteResult = await quote(resource, amount, duration);

    log.info(
      `[marketplace] fulfilling via ${quoteResult.source}: ${resource} ${amount} → ${buyerWallet}`,
    );

    // Fulfil through Brutus
    const order =
      resource === 'energy'
        ? await brutus.orderEnergy(buyerWallet, amount, duration, userId)
        : await brutus.orderBandwidth(buyerWallet, amount, duration, userId);

    const actualCost = order.payment ?? quoteResult.brutusCostTrx;
    const spread = quoteResult.buyerPriceTrx - actualCost;

    log.info(
      `[marketplace] fulfilled: cost=${actualCost} TRX, charged=${quoteResult.buyerPriceTrx} TRX, spread=${spread.toFixed(6)} TRX`,
    );

    return {
      resource,
      amount,
      duration,
      source: quoteResult.source,
      brutusCostTrx: actualCost,
      buyerPriceTrx: quoteResult.buyerPriceTrx,
      spreadTrx: spread,
      txIds: order.tx_id ?? [],
    };
  }

  return { quote, getRates, fulfill };
}
