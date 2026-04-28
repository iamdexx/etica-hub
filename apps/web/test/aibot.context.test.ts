import { describe, expect, it, vi } from 'vitest';
import { fetchLiveContext } from '../src/lib/aibot/context';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const FIXED_NOW = 1_750_000_000;

function fetchByPath(map: Record<string, unknown | (() => Response | Promise<Response>)>) {
  return vi.fn().mockImplementation((url) => {
    const path = new URL(String(url)).pathname;
    if (path in map) {
      const v = map[path];
      if (typeof v === 'function') return Promise.resolve((v as () => Response)());
      return Promise.resolve(jsonResponse(v));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

describe('aibot live-context fetcher', () => {
  it('renders TVL, revenue, harvester and pool summaries', async () => {
    const fetchImpl = fetchByPath({
      '/api/v1/tvl': { etx_tvl: 1_500_000, usd_tvl: 11_700, pool_count: 3 },
      '/api/v1/stats': { pair_count: 3, block_number: 200_000, listed_assets: ['ETI', 'ETX', 'WEGAZ'] },
      '/api/v1/revenue': {
        volume_etx: 5_000_000,
        volume_usd: 38_000,
        lp_fees_etx: 15_000,
        protocol_fees_accrued_etx: 2_500,
        protocol_fees_realized_etx: 1_200,
        harvest: {
          runs: 7,
          last_run_unix: FIXED_NOW - 3 * 3600,
          total_etx_burned_pol: 120_000,
          total_etx_to_treasury: 80_000,
          total_etx_to_stetx: 20_000,
          total_etx_to_farms: 20_000,
        },
      },
      '/api/v1/liquidity-flow': {
        lp_retention_pct: 98.4,
        total_lp_minted_etx: 3_400_000,
        total_lp_burned_etx: 54_000,
      },
      '/api/v1/pools': {
        pools: [
          {
            base: { symbol: 'ETI', address: '0x1' },
            quote: { symbol: 'ETX', address: '0x2' },
            price: 0.025,
            volume_24h: { swap_count: 14 },
          },
          {
            base: { symbol: 'WEGAZ', address: '0x3' },
            quote: { symbol: 'ETX', address: '0x4' },
            price: 1.5,
            volume_24h: { swap_count: 7 },
          },
        ],
      },
      '/api/v1/tokens/etx': {
        token: { id: 'etx', symbol: 'ETX', decimals: 18 },
        supply: {
          totalSupplyFormatted: '21,000,000',
          circulatingSupplyFormatted: '20,950,000',
          burnedFormatted: '50,000',
        },
        prices: { usd: 0.0078 },
      },
      '/api/v1/tokens/stetx': {
        token: { id: 'stetx', symbol: 'stETX', decimals: 18 },
        supply: {
          totalSupplyFormatted: '120,000',
          circulatingSupplyFormatted: '120,000',
          burnedFormatted: '0',
        },
        prices: { etx: 1.012345, usd: 0.0079 },
      },
    });

    const ctx = await fetchLiveContext({
      baseUrl: 'https://eticahub.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowUnix: FIXED_NOW,
    });

    expect(ctx.errors).toEqual([]);
    expect(ctx.loaded).toEqual(
      expect.arrayContaining([
        'tvl',
        'stats',
        'revenue',
        'liquidity-flow',
        'pools',
        'tokens/etx',
        'tokens/stetx',
      ]),
    );
    expect(ctx.text).toContain('TVL: $11.70K');
    expect(ctx.text).toContain('Lifetime swap volume:');
    expect(ctx.text).toContain('TreasuryHarvester: 7 runs');
    expect(ctx.text).toContain('3h ago');
    expect(ctx.text).toContain('LP retention since launch: 98.40%');
    expect(ctx.text).toContain('ETI/ETX');
    expect(ctx.text).toContain('14 swaps/24h');
    expect(ctx.text).toContain('ETX supply:');
    expect(ctx.text).toContain('21,000,000');
    expect(ctx.text).toContain('stETX supply:');
    expect(ctx.text).toContain('stETX exchange rate: 1 stETX = 1.012345 ETX');
  });

  it('omits failed endpoints but still renders the rest', async () => {
    const fetchImpl = fetchByPath({
      '/api/v1/tvl': () => new Response('oops', { status: 500 }),
      '/api/v1/stats': { listed_assets: ['ETX'] },
      '/api/v1/revenue': { volume_etx: 100, volume_usd: 1 },
      '/api/v1/liquidity-flow': () => new Response('oops', { status: 500 }),
      '/api/v1/pools': { pools: [] },
    });

    const ctx = await fetchLiveContext({
      baseUrl: 'https://eticahub.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowUnix: FIXED_NOW,
    });

    expect(ctx.errors.map((e) => e.endpoint)).toEqual(
      expect.arrayContaining(['/api/v1/tvl', '/api/v1/liquidity-flow']),
    );
    expect(ctx.loaded).toEqual(expect.arrayContaining(['stats', 'revenue', 'pools']));
    expect(ctx.text).toContain('Lifetime swap volume:');
    expect(ctx.text).not.toContain('TVL:');
    expect(ctx.text).not.toContain('LP retention');
  });

  it('returns a fallback message when every endpoint fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('oops', { status: 500 }));
    const ctx = await fetchLiveContext({
      baseUrl: 'https://eticahub.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ctx.text).toContain('live context unavailable');
    expect(ctx.errors.length).toBeGreaterThan(0);
    expect(ctx.loaded).toEqual([]);
  });
});
