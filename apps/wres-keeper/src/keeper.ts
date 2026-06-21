/**
 * Keeper wiring + single-tick orchestration.
 *
 * `createKeeper` builds the two chain adapters from config; `runTick` performs
 * one full pass: observe both chains -> build a plan -> execute it. Both the
 * long-running loop (`index.ts`) and the one-shot dry run (`dry-run.ts`) reuse
 * this, so they exercise identical logic.
 */

import { createEticaClient } from './chains/etica.js';
import { createTronClient } from './chains/tron.js';
import type { EticaClient, TronClient } from './chains/types.js';
import type { WresKeeperConfig } from './config.js';
import { executePlan, type ExecutionReport } from './executor.js';
import { observe } from './monitor.js';
import { buildPlan, isEmptyPlan } from './planner.js';
import type { Logger } from './types.js';

export interface Keeper {
  config: WresKeeperConfig;
  etica: EticaClient;
  tron: TronClient;
  log: Logger;
}

const EMPTY_REPORT: ExecutionReport = { minted: 0, fronted: 0, paid: 0, skipped: 0 };

export function createKeeper(config: WresKeeperConfig, log: Logger = console): Keeper {
  return {
    config,
    etica: createEticaClient(config, log),
    tron: createTronClient(config, log),
    log,
  };
}

export async function runTick(keeper: Keeper): Promise<ExecutionReport> {
  const { config, etica, tron, log } = keeper;

  const observation = await observe(etica, tron, log);
  const plan = buildPlan(observation, {
    initialFrontSun: config.initialFrontSun,
    minPayoutSun: config.minPayoutSun,
    reserveTopUpBps: config.reserveTopUpBps,
    keeperOpsBps: config.keeperOpsBps,
  });

  if (isEmptyPlan(plan)) {
    log.info('[keeper] idle tick — no entries or payouts');
    return { ...EMPTY_REPORT };
  }

  log.info(
    `[keeper] plan: ${plan.entries.length} entr(y/ies), ` +
      `${plan.payouts.length} payout(s)`,
  );
  return executePlan(plan, { config, etica, tron, log });
}
