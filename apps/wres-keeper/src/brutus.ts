/**
 * Brutus Energy API adapter.
 *
 * Brutus is a TRON energy/bandwidth rental service. We use it as a **fallback
 * supplier**: when our own pool can't cover a buyer's order, we fulfil it
 * through Brutus at their rate + a configurable markup (default 15%).
 *
 * API docs: https://e-bot.brutusservices.com/main/docs
 *
 * Authentication: every authenticated call requires:
 *   - header `token-api` — API token
 *   - body   `id_api`    — API user ID
 *
 * Billing: orders deduct TRX from the rechargeable wallet associated with the
 * API account. Keep it funded.
 */

import type { Logger } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceType = 'energy' | 'bandwidth';

export type RentalDuration =
  | '1min'
  | '5min'
  | '1h'
  | '1'
  | '2'
  | '3'
  | '5'
  | '10'
  | '14'
  | '30';

export interface BrutusConfig {
  apiId: string;
  apiToken: string;
  baseUrl?: string;
}

export interface BrutusRates {
  energy_minutes_100K: number;
  energy_hour_100K: number;
  energy_one_day_100K: number;
  energy_over_one_day_100K: number;
  band_minutes_1000: number;
  band_hour_1000: number;
  band_one_day_1000: number;
  band_over_one_day_1000: number;
}

export interface AvailabilitySlot {
  period: number;
  available: number;
}

export interface BrutusAvailability {
  av_energy: AvailabilitySlot[];
  av_band: AvailabilitySlot[];
  total_energy_pool: number;
  total_bandwidth_pool: number;
}

export interface BrutusBalance {
  uses: number;
  limit: number;
  balance: number;
  pending_to_collect: number;
  available_balance: number;
}

export interface BrutusPriceResult {
  response: number;
  price?: string;
  msg?: string;
}

export interface BrutusOrderResult {
  response: number;
  wallet_buyer?: string;
  energy_required?: number;
  bandwidth_required?: number;
  rental_duration?: string;
  lock?: string;
  payment?: number;
  balance_left?: number;
  tx_id?: string[];
  requests_left?: number;
  partial?: boolean;
  energy_received?: number;
  bandwidth_received?: number;
  msg?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface BrutusClient {
  getRates(): Promise<BrutusRates>;
  getAvailability(wallet?: string): Promise<BrutusAvailability>;
  getBalance(): Promise<BrutusBalance>;
  getPrice(resource: ResourceType, amount: number, duration: RentalDuration): Promise<number>;
  orderEnergy(wallet: string, amount: number, duration: RentalDuration, userId: string): Promise<BrutusOrderResult>;
  orderBandwidth(wallet: string, amount: number, duration: RentalDuration, userId: string): Promise<BrutusOrderResult>;
}

export function createBrutusClient(config: BrutusConfig, log: Logger): BrutusClient {
  const base = config.baseUrl ?? 'https://e-bot.brutusservices.com/main';

  async function apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`Brutus GET ${path}: ${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  async function apiPost<T>(path: string, body: Record<string, unknown>, authenticated = false): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authenticated) headers['token-api'] = config.apiToken;
    const payload = authenticated ? { id_api: config.apiId, ...body } : body;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Brutus POST ${path}: ${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  async function getRates(): Promise<BrutusRates> {
    return apiGet<BrutusRates>('/prices/all');
  }

  async function getAvailability(wallet?: string): Promise<BrutusAvailability> {
    const qs = wallet ? `?wallet=${wallet}` : '';
    return apiGet<BrutusAvailability>(`/available${qs}`);
  }

  async function getBalance(): Promise<BrutusBalance> {
    return apiPost<BrutusBalance>('/available/current_use', {}, true);
  }

  async function getPrice(resource: ResourceType, amount: number, duration: RentalDuration): Promise<number> {
    const result = await apiPost<BrutusPriceResult>('/prices', {
      resource: resource === 'energy' ? 'energy' : 'bandwidth',
      amount,
      duration,
    });
    if (result.response !== 1 || !result.price) {
      throw new Error(`Brutus price error: ${result.msg ?? 'unknown'}`);
    }
    return parseFloat(result.price);
  }

  async function orderEnergy(
    wallet: string,
    amount: number,
    duration: RentalDuration,
    userId: string,
  ): Promise<BrutusOrderResult> {
    log.info(`[brutus] ordering energy: wallet=${wallet} amount=${amount} duration=${duration}`);
    const result = await apiPost<BrutusOrderResult>(
      '/energy',
      { wallet, amount, time: duration, user_id: userId },
      true,
    );
    if (result.response !== 1) {
      log.error(`[brutus] energy order failed: ${result.msg}`);
      throw new Error(`Brutus energy order failed: ${result.msg ?? 'unknown'}`);
    }
    log.info(`[brutus] energy order success: payment=${result.payment} tx_id=${result.tx_id?.join(',')}`);
    return result;
  }

  async function orderBandwidth(
    wallet: string,
    amount: number,
    duration: RentalDuration,
    userId: string,
  ): Promise<BrutusOrderResult> {
    log.info(`[brutus] ordering bandwidth: wallet=${wallet} amount=${amount} duration=${duration}`);
    const result = await apiPost<BrutusOrderResult>(
      '/band',
      { wallet, amount, time: duration, user_id: userId },
      true,
    );
    if (result.response !== 1) {
      log.error(`[brutus] bandwidth order failed: ${result.msg}`);
      throw new Error(`Brutus bandwidth order failed: ${result.msg ?? 'unknown'}`);
    }
    log.info(`[brutus] bandwidth order success: payment=${result.payment} tx_id=${result.tx_id?.join(',')}`);
    return result;
  }

  return { getRates, getAvailability, getBalance, getPrice, orderEnergy, orderBandwidth };
}
