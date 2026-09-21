import { describe, expect, it } from 'vitest';
import {
  isFullySanctionedCountry,
  isGeoRestricted,
  resolveCountry,
  RESTRICTED_PATHS,
} from '../src/lib/geoBlock';

function headersOf(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

describe('resolveCountry', () => {
  it('prefers cf-ipcountry over x-vercel-ip-country (Cloudflare fronts Vercel)', () => {
    expect(
      resolveCountry(headersOf({ 'cf-ipcountry': 'KR', 'x-vercel-ip-country': 'US' })),
    ).toBe('KR');
  });

  it('falls back to x-vercel-ip-country when Cloudflare is not in the path', () => {
    expect(resolveCountry(headersOf({ 'x-vercel-ip-country': 'de' }))).toBe('DE');
  });

  it('treats Cloudflare XX / T1 pseudo-codes as unknown', () => {
    expect(resolveCountry(headersOf({ 'cf-ipcountry': 'XX' }))).toBeNull();
    expect(
      resolveCountry(headersOf({ 'cf-ipcountry': 'T1', 'x-vercel-ip-country': 'JP' })),
    ).toBe('JP');
  });

  it('returns null with no geo headers at all', () => {
    expect(resolveCountry(headersOf({}))).toBeNull();
  });
});

describe('isFullySanctionedCountry', () => {
  it('blocks North Korea (KP) but not South Korea (KR)', () => {
    expect(isFullySanctionedCountry('KP')).toBe(true);
    expect(isFullySanctionedCountry('KR')).toBe(false);
    expect(isFullySanctionedCountry('kr')).toBe(false);
  });
});

describe('isGeoRestricted', () => {
  it('returns false when no country header is present (local dev / unknown geo)', () => {
    expect(isGeoRestricted('/stake', null)).toBe(false);
    expect(isGeoRestricted('/farms', null)).toBe(false);
  });

  it('returns false for non-restricted countries', () => {
    for (const cc of ['CA', 'GB', 'DE', 'JP', 'BR', 'IN']) {
      expect(isGeoRestricted('/stake', cc)).toBe(false);
      expect(isGeoRestricted('/farms', cc)).toBe(false);
    }
  });

  it('returns true for US visitors on /stake (exact match)', () => {
    expect(isGeoRestricted('/stake', 'US')).toBe(true);
  });

  it('returns true for US visitors on /farms (exact match)', () => {
    expect(isGeoRestricted('/farms', 'US')).toBe(true);
  });

  it('returns true for US visitors on nested sub-paths', () => {
    expect(isGeoRestricted('/stake/withdraw', 'US')).toBe(true);
    expect(isGeoRestricted('/farms/0xdeadbeef', 'US')).toBe(true);
  });

  it('is case-insensitive on the country code', () => {
    expect(isGeoRestricted('/stake', 'us')).toBe(true);
    expect(isGeoRestricted('/stake', 'Us')).toBe(true);
  });

  it('does NOT block /swap, /trade, /pool, /bridge, /explorer for US visitors', () => {
    for (const path of ['/swap', '/trade', '/trade/ETI', '/pool', '/bridge', '/explorer', '/']) {
      expect(isGeoRestricted(path, 'US')).toBe(false);
    }
  });

  it('does not match unrelated paths that happen to share a prefix string', () => {
    // e.g. a hypothetical /staked-something route should NOT be blocked.
    expect(isGeoRestricted('/staked-asset-info', 'US')).toBe(false);
    expect(isGeoRestricted('/farmstead', 'US')).toBe(false);
  });

  it('exposes a frozen list of restricted paths (callers must not mutate)', () => {
    // Compile-time guard: readonly[]. Runtime guard: the constant array is
    // exactly what the middleware matcher pattern in `middleware.ts` covers.
    expect(RESTRICTED_PATHS).toEqual(['/stake', '/farms']);
  });
});
