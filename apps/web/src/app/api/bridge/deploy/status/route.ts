import {
  listBridgeDeployRuns,
  renderedAddressesForRun,
  type DeployRun,
  type RenderedAddresses,
} from '@/lib/bridge-deploy/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface DeployRunWithAddresses extends DeployRun {
  addresses: RenderedAddresses | null;
}

const CACHE_MS = 10_000;
let cached: { at: number; value: { runs: DeployRunWithAddresses[] } } | null = null;

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return Response.json(cached.value);
  try {
    const runs = await listBridgeDeployRuns();
    const withAddresses = await Promise.all(
      runs.map(async (run) => ({
        ...run,
        addresses:
          run.conclusion === 'success' ? await renderedAddressesForRun(run.id).catch(() => null) : null,
      })),
    );
    const value = { runs: withAddresses };
    cached = { at: now, value };
    return Response.json(value);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'status failed' },
      { status: 502 },
    );
  }
}
