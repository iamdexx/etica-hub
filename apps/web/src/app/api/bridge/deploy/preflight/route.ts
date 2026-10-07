import { bridgeDeployPreflight, type BridgeDeployPreflight } from '@/lib/bridge-deploy/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CACHE_MS = 20_000;
let cached: { at: number; value: BridgeDeployPreflight } | null = null;

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return Response.json(cached.value);
  try {
    const value = await bridgeDeployPreflight();
    cached = { at: now, value };
    return Response.json(value);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'preflight failed' },
      { status: 502 },
    );
  }
}
