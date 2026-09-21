/**
 * GET /api/geo
 *
 * Diagnostic for the frontend geo gate: reports the country the edge
 * resolved for this request and how the compliance policy classifies it.
 * Exposes only the visitor's own country code — no IP, no other PII.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  isFullySanctionedCountry,
  isGeoRestrictedCountry,
  resolveCountry,
} from '@/lib/geoBlock';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest): NextResponse {
  const country = resolveCountry(req.headers);
  return NextResponse.json(
    {
      country,
      sources: {
        cloudflare: req.headers.get('cf-ipcountry'),
        vercel: req.headers.get('x-vercel-ip-country'),
      },
      sanctioned: isFullySanctionedCountry(country),
      stetxRestricted: isGeoRestrictedCountry(country),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
