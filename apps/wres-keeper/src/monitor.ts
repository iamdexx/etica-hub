/**
 * Observation gathering.
 *
 * Each tick the monitor reads both chains and assembles a single `Observation`
 * snapshot for the planner: pending registrations from the Etica adapter and
 * the minted TRON twins with their settled rewards. All reads are wrapped in
 * `withRetry` so a transient RPC blip doesn't abort the tick.
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

  const [registrations, tronObs] = await Promise.all([
    withRetry(() => etica.scanRegistrations(), { ...retry, label: 'scanRegistrations' }),
    withRetry(() => tron.scanTwins(), { ...retry, label: 'scanTwins' }),
  ]);

  return {
    registrations,
    mintedByResTokenId: tronObs.mintedByResTokenId,
    twins: tronObs.twins,
  };
}
