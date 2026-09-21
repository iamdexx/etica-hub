/**
 * GET /api/openapi.json — OpenAPI 3.1 description of every public read-only
 * endpoint, generated from the same catalogue that renders /api. Lets
 * aggregators, LLM tool builders and API explorers import EticaHub in one
 * step.
 */

import { ENDPOINTS, LABS_ENDPOINTS, type EndpointRow } from '@/lib/apiCatalog';
import { SITE_URL } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

const PARAM_RE = /\[([a-zA-Z]+)\]/g;

function toOperation(e: EndpointRow, tag: string) {
  const [rawPath, query = ''] = e.pathTemplate.split('?');
  const path = rawPath.replace(PARAM_RE, '{$1}');
  const parameters = [
    ...Array.from(rawPath.matchAll(PARAM_RE), (m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    ...query
      .split('&')
      .filter(Boolean)
      .map((kv) => kv.split('=')[0])
      .map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
  ];
  const contentType = e.contentType ?? 'application/json';
  const schema =
    contentType === 'application/json' || contentType === 'application/feed+json'
      ? { type: 'object' }
      : { type: 'string' };
  return {
    path,
    operation: {
      operationId: path.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '_'),
      summary: e.summary,
      tags: [tag],
      parameters,
      responses: {
        '200': { description: 'OK', content: { [contentType]: { schema } } },
      },
    },
  };
}

export async function GET(): Promise<Response> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [rows, tag] of [
    [ENDPOINTS, 'Market data'],
    [LABS_ENDPOINTS, 'Labs research'],
  ] as const) {
    for (const e of rows) {
      const { path, operation } = toOperation(e, tag);
      paths[path] = { ...(paths[path] ?? {}), get: operation };
    }
  }

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'EticaHub public API',
      version: '1.0.0',
      description:
        'Read-only market data for EticaSwap / stETX on Etica mainnet (chain id 61803) plus the autonomous Labs research archive. No auth, permissive CORS.',
      contact: { url: `${SITE_URL}/api` },
      license: {
        name: 'EticaHub Proprietary License v1.0',
        url: 'https://github.com/iamdexx/etica-hub/blob/main/LICENSE',
      },
    },
    servers: [{ url: SITE_URL }],
    tags: [
      { name: 'Market data', description: 'Prices, pairs, supply, TVL, revenue, health.' },
      { name: 'Labs research', description: 'Archived AI protein-design discoveries and feeds.' },
    ],
    paths,
  };

  return Response.json(spec, {
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
