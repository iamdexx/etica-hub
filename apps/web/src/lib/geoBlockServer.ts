import { headers } from 'next/headers';
import { isGeoRestrictedCountry, resolveCountry } from './geoBlock';

/**
 * Server-component helper. Resolves the visitor's country from the request
 * headers (Cloudflare's `cf-ipcountry`, falling back to Vercel's
 * `x-vercel-ip-country`; both are set at the edge before any middleware or
 * route handler runs, so they're available on `/swap` and `/pool` even
 * though those paths are not in the middleware matcher) and returns the
 * boolean the page tree should branch on.
 *
 * Kept in a separate file from `geoBlock.ts` because `next/headers` is
 * server-only and cannot be imported into the edge middleware module.
 */
export function getServerGeoRestricted(): boolean {
  return isGeoRestrictedCountry(resolveCountry(headers()));
}
