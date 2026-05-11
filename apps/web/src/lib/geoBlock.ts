/**
 * Geo-restriction policy for yield-bearing surfaces.
 *
 * EticaHub is a non-custodial protocol — the smart contracts themselves are
 * permissionless and cannot enforce any geographic restriction. This module
 * applies a *frontend-only* compliance gate on the `/stake` and `/farms`
 * pages, which surface yield-bearing instruments (stETX exchange-rate accrual,
 * ETXFarms LP staking). The gate is best-effort: any user with a VPN can
 * trivially bypass it. The intent is to mirror the same good-faith posture
 * adopted by Uniswap, Aave, and similar US-aware DeFi frontends.
 *
 * The middleware that consumes this module reads the country from
 * `request.geo.country` (Vercel Edge runtime) with a fallback to the
 * `x-vercel-ip-country` header so this is testable without the Vercel runtime.
 */
export const RESTRICTED_PATHS: readonly string[] = ['/stake', '/farms'] as const;

export const RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set(['US']);

/**
 * Returns true if the request should be redirected to the `/restricted`
 * compliance notice. Pure function — accepts the inputs the middleware has
 * already extracted (path + country code), no Request object required, so
 * it's straightforward to unit test.
 */
export function isGeoRestricted(pathname: string, country: string | null): boolean {
  if (!country) return false;
  if (!RESTRICTED_COUNTRIES.has(country.toUpperCase())) return false;
  return RESTRICTED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}
