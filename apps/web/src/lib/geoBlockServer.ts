import { headers } from 'next/headers';
import { isGeoRestrictedCountry } from './geoBlock';

/**
 * Server-component helper. Reads the visitor's country from the
 * `x-vercel-ip-country` request header (Vercel sets this on every request
 * out of the edge before any middleware or route handler runs, so it's
 * available on `/swap` and `/pool` even though those paths are not in the
 * middleware matcher) and returns the boolean the page tree should branch
 * on.
 *
 * Kept in a separate file from `geoBlock.ts` because `next/headers` is
 * server-only and cannot be imported into the edge middleware module.
 */
export function getServerGeoRestricted(): boolean {
  const country = headers().get('x-vercel-ip-country');
  return isGeoRestrictedCountry(country);
}
