import { NextRequest } from 'next/server';
import { listEngines } from '@/lib/labs/engines/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest): Promise<Response> {
  return Response.json({
    engines: listEngines(),
  });
}
