import { NextResponse, type NextRequest } from 'next/server';
import { isGeoRestricted } from './lib/geoBlock';

/**
 * Edge middleware. Reads the visitor's country from either the Vercel
 * `request.geo` object (production) or the `x-vercel-ip-country` header
 * (which Vercel sets on the same code path and which we can also stub in
 * tests / local curl). When the path is in `RESTRICTED_PATHS` *and* the
 * country is in `RESTRICTED_COUNTRIES`, we rewrite — not redirect — to the
 * `/restricted` compliance notice so the URL bar stays on the user's
 * original target. Anything else passes through untouched.
 */
export function middleware(req: NextRequest): NextResponse {
  const country =
    req.geo?.country ?? req.headers.get('x-vercel-ip-country') ?? null;

  if (isGeoRestricted(req.nextUrl.pathname, country)) {
    const url = req.nextUrl.clone();
    url.pathname = '/restricted';
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

/**
 * Only invoke this middleware on the two restricted sub-trees. Excluding
 * the rest of the site avoids paying the edge function cost on every page
 * view and keeps the blast radius of any bug here narrow.
 */
export const config = {
  matcher: ['/stake/:path*', '/farms/:path*'],
};
