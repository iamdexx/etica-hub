/**
 * Public Etherscan-compatible API for Etica mainnet, served from eticahub.com:
 *   /api/explorer?module=account&action=txlist&address=0x…
 *   /api/explorer?module=account&action=tokentx&address=0x…
 *   /api/explorer?module=token&action=tokenholderlist&contractaddress=0x…
 *   /api/explorer?module=logs&action=getLogs&address=0x…&topic0=0x…
 * Proxies to the self-hosted full-chain index (apps/explorer-api). Pagination
 * (`page`, `offset` ≤ 1000) and `sort=asc|desc` follow Etherscan's conventions.
 */
import { NextResponse } from 'next/server';
import { hubQuery } from '@/lib/explorerHub';

export const dynamic = 'force-dynamic';

const ALLOWED = [
  'module',
  'action',
  'address',
  'contractaddress',
  'page',
  'offset',
  'sort',
  'startblock',
  'endblock',
  'fromBlock',
  'toBlock',
  'topic0',
  'topic1',
  'topic2',
  'topic3',
  'days',
];

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  for (const k of ALLOWED) {
    const v = url.searchParams.get(k);
    if (v != null && v.length <= 200) params[k] = v;
  }
  if (!params.module || !params.action) {
    return NextResponse.json(
      { status: '0', message: 'Error! Missing module or action', result: null },
      { status: 400 },
    );
  }
  const r = await hubQuery<unknown>(params);
  if (!r) {
    return NextResponse.json(
      { status: '0', message: 'Error! Index unavailable', result: null },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(r, {
    headers: { 'Cache-Control': 'public, max-age=15', 'Access-Control-Allow-Origin': '*' },
  });
}
