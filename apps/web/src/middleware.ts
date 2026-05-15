import { NextResponse, type NextRequest } from 'next/server';
import { isFullySanctionedCountry, isGeoRestricted } from './lib/geoBlock';

const ROUTE_ALIASES: Record<string, string> = {
  '/blocks': '/explorer',
  '/transactions': '/explorer',
  '/contracts': '/explorer',
  '/explorer/blocks': '/explorer',
  '/explorer/transactions': '/explorer',
  '/explorer/contracts': '/explorer',
  '/explorer/research': '/research',
  '/explorer/bridge': '/bridge',
};

export function middleware(req: NextRequest): NextResponse {
  const alias = ROUTE_ALIASES[req.nextUrl.pathname];

  if (alias) {
    const url = req.nextUrl.clone();
    url.pathname = alias;
    url.search = '';
    return NextResponse.redirect(url);
  }

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

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/|restricted).*)',
  ],
};
