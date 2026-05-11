/**
 * Geo-restriction policy.
 *
 * EticaHub is a non-custodial protocol — the smart contracts themselves are
 * permissionless and cannot enforce any geographic restriction. This module
 * applies a *frontend-only* compliance gate. Two policies are layered:
 *
 * 1. **`SANCTIONED_COUNTRIES`** (KP / SY / CU / IR — the comprehensive-sanctions
 *    OFAC list). The entire EticaHub frontend is rewritten to `/restricted`
 *    on every path for these visitors.
 * 2. **`RESTRICTED_COUNTRIES`** (US). Only the stETX-related surfaces are
 *    suppressed: `/stake` and `/farms` rewrite to `/restricted`, and on
 *    `/swap` and `/pool` the page components read the country header server
 *    side and filter stETX out of pickers / pair selectors / positions lists.
 *
 * The gate is best-effort and trivially bypassed by a VPN. The intent is to
 * mirror the same good-faith posture adopted by Uniswap, Aave, and similar
 * US-aware DeFi frontends.
 *
 * The middleware that consumes this module reads the country from
 * `request.geo.country` (Vercel Edge runtime) with a fallback to the
 * `x-vercel-ip-country` header so this is testable without the Vercel runtime.
 */
export const RESTRICTED_PATHS: readonly string[] = ['/stake', '/farms'] as const;

export const RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set(['US']);

/**
 * Countries under comprehensive sanctions where the entire EticaHub frontend
 * is unavailable, not just the stETX surfaces. Codes are ISO 3166-1 alpha-2.
 *   - KP: North Korea (DPRK)
 *   - SY: Syria
 *   - CU: Cuba
 *   - IR: Iran
 */
export const SANCTIONED_COUNTRIES: ReadonlySet<string> = new Set([
  'KP',
  'SY',
  'CU',
  'IR',
]);

/**
 * Returns true if the request should be rewritten to the `/restricted`
 * compliance notice under the US stETX-surface policy. Pure function —
 * accepts the inputs the middleware has already extracted (path + country
 * code), no Request object required, so it's straightforward to unit test.
 */
export function isGeoRestricted(pathname: string, country: string | null): boolean {
  if (!country) return false;
  if (!RESTRICTED_COUNTRIES.has(country.toUpperCase())) return false;
  return RESTRICTED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Country-only check. Used by server-component page wrappers to decide
 * whether the rendered tree should hide stETX-related surfaces (stETX
 * token picker on `/swap`, stETX pair in `/pool` add card, stableswap LP
 * card, stETX-containing positions in the `/pool` positions list). The
 * `/stake` and `/farms` full-page rewrites still go through `isGeoRestricted`
 * + the middleware matcher.
 */
export function isGeoRestrictedCountry(country: string | null): boolean {
  if (!country) return false;
  return RESTRICTED_COUNTRIES.has(country.toUpperCase());
}

/**
 * Returns true if the visitor's country is on the comprehensive-sanctions
 * list and the entire EticaHub frontend should be rewritten to
 * `/restricted` regardless of path.
 */
export function isFullySanctionedCountry(country: string | null): boolean {
  if (!country) return false;
  return SANCTIONED_COUNTRIES.has(country.toUpperCase());
}
