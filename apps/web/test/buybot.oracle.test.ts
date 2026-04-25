import { describe, expect, it, vi } from 'vitest';
import { fetchEgazNativeSupply } from '../src/lib/buybot/oracle';

const config = { eticaStatsExplorerUrl: 'http://explorer.etica-stats.org' } as const;

function mockFetch(impl: (url: string) => Response | Promise<Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url);
  }) as unknown as typeof fetch;
}

describe('fetchEgazNativeSupply', () => {
  it('parses BlockScout coinsupply text into a raw 18-decimal bigint', async () => {
    const f = mockFetch((url) => {
      expect(url).toBe('http://explorer.etica-stats.org/api?module=stats&action=coinsupply');
      return new Response('20155344.625', { status: 200 });
    });
    const out = await fetchEgazNativeSupply(config, f);
    // 20155344.625 → 20155344625000000000000000n
    expect(out).toBe(20_155_344_625_000_000_000_000_000n);
  });

  it('handles integer-only supplies without a decimal point', async () => {
    const f = mockFetch(() => new Response('19000000', { status: 200 }));
    const out = await fetchEgazNativeSupply(config, f);
    expect(out).toBe(19_000_000n * 10n ** 18n);
  });

  it('truncates fractional digits beyond 18 places without throwing', async () => {
    // 19 fractional digits — last digit must be discarded, not crash.
    const f = mockFetch(() => new Response('1.1234567890123456789', { status: 200 }));
    const out = await fetchEgazNativeSupply(config, f);
    // Truncated to 18 decimals: 1.123456789012345678 → 1_123456789012345678
    expect(out).toBe(1n * 10n ** 18n + 123_456_789_012_345_678n);
  });

  it('returns null on non-numeric responses (e.g. HTML error page)', async () => {
    const f = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
    expect(await fetchEgazNativeSupply(config, f)).toBeNull();
  });

  it('returns null when the explorer responds with non-2xx', async () => {
    const f = mockFetch(() => new Response('boom', { status: 502 }));
    expect(await fetchEgazNativeSupply(config, f)).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const f = (async () => {
      throw new Error('net down');
    }) as unknown as typeof fetch;
    expect(await fetchEgazNativeSupply(config, f)).toBeNull();
  });

  it('returns null when supply parses to zero', async () => {
    const f = mockFetch(() => new Response('0', { status: 200 }));
    expect(await fetchEgazNativeSupply(config, f)).toBeNull();
  });

  it('strips trailing slashes from the configured base URL', async () => {
    let observedUrl = '';
    const f = mockFetch((url) => {
      observedUrl = url;
      return new Response('1', { status: 200 });
    });
    await fetchEgazNativeSupply({ eticaStatsExplorerUrl: 'http://explorer.etica-stats.org/' }, f);
    expect(observedUrl).toBe('http://explorer.etica-stats.org/api?module=stats&action=coinsupply');
  });
});
