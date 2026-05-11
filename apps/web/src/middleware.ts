import { NextResponse, type NextRequest } from 'next/server';
import { isFullySanctionedCountry, isGeoRestricted } from './lib/geoBlock';

/**
 * Edge middleware. Reads the visitor's country from either the Vercel
 * `request.geo` object (production) or the `x-vercel-ip-country` header
 * (which Vercel sets on the same code path and which we can also stub in
 * tests / local curl), then applies two layered policies:
 *
 * 1. **Comprehensive sanctions (KP / SY / CU / IR).** Every path is
 *    rewritten to `/restricted` (with a `reason=sanctioned` marker so the
 *    notice page can swap to full-site messaging). The `/restricted` page
 *    itself and Next's internal `_next/*` / `api/*` routes are excluded by
 *    the matcher so the rewrite never loops.
 * 2. **US stETX surfaces (`/stake`, `/farms`).** Rewrites to `/restricted`
 *    for US visitors only. The `/swap` and `/pool` page components apply
 *    their own server-side stETX filtering by reading the same country
 *    header directly (see `lib/geoBlockServer.ts`); they do not need a
 *    middleware rewrite.
 *
 * Anything else passes through untouched.
 */
export function middleware(req: NextRequest): NextResponse {
  const country =
    req.geo?.country ?? req.headers.get('x-vercel-ip-country') ?? null;

  if (isFullySanctionedCountry(country)) {
    const url = req.nextUrl.clone();
    url.pathname = '/restricted';
    url.searchParams.set('reason', 'sanctioned');
    return NextResponse.rewrite(url);
  }

  if (isGeoRestricted(req.nextUrl.pathname, country)) {
    const url = req.nextUrl.clone();
    url.pathname = '/restricted';
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

/**
 * Matcher excludes Next's internal routes, the public asset paths, and the
 * `/restricted` page itself (to prevent rewrite loops for sanctioned
 * visitors). Everything else is inspected so a sanctioned-country visitor
 * is gated on every page they try to reach.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/|restricted).*)',
  ],
};
