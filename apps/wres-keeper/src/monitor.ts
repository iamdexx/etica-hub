/**
 * Observation gathering.
 *
 * Each tick the monitor reads both chains and assembles a single `Observation`
 * snapshot for the planner: active Etica locks, pending unlock requests + the
 * current Etica time (to mature them), and the minted TRON twins with their
 * settled rewards. All reads are wrapped in `withRetry` so a transient RPC blip
 * doesn't abort the tick.
 */

import type { EticaClient, TronClient } from './chains/types.js';
import type { Logger, Observation } from './types.js';
import { withRetry } from './utils.js';

export async function observe(
  etica: EticaClient,
  tron: TronClient,
  log: Logger,
): Promise<Observation> {
  const retry = { attempts: 3, baseDelayMs: 500, log };

  const [locks, pendingUnlocks, nowSec, tronObs] = await Promise.all([
    withRetry(() => etica.scanActiveLocks(), { ...retry, label: 'scanActiveLocks' }),
    withRetry(() => etica.scanPendingUnlocks(), { ...retry, label: 'scanPendingUnlocks' }),
    withRetry(() => etica.now(), { ...retry, label: 'eticaNow' }),
    withRetry(() => tron.scanTwins(), { ...retry, label: 'scanTwins' }),
  ]);

  return {
    locks,
    mintedByResTokenId: tronObs.mintedByResTokenId,
    twins: tronObs.twins,
    pendingUnlocks,
    nowSec,
  };
}
