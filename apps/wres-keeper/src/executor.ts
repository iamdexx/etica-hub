/**
 * Plan execution.
 *
 * Turns a `KeeperPlan` into ordered on-chain calls across both chains. In
 * dry-run (`config.dryRun`) it logs exactly what it *would* broadcast and never
 * touches a write method — the adapters also throw without a signer, so a dry
 * run can never move funds even if a call slipped through.
 *
 * Ordering per tick:
 *   1. Entries : mintTwin (TRON) -> frontUpgrade from reserve (bounded by the
 *                reserve's frontable budget this epoch)
 *   2. Payouts : claimForPayout (TRON) -> reserve topUp (TRON)
 *                -> keeper ops retention (TRON) -> mint eTRX -> approve
 *                -> swap eTRX->ETX to the holder (Etica)
 *
 * Each item is isolated in try/catch so a single failure (e.g. a thin reserve)
 * never aborts the rest of the tick.
 */

import type { EticaClient, TronClient } from './chains/types.js';
import { BPS_DENOMINATOR, type KeeperPlan, type Logger } from './types.js';
import type { WresKeeperConfig } from './config.js';
import { formatTrx, sunToEtrxWei } from './utils.js';

export interface ExecutionReport {
  minted: number;
  fronted: number;
  paid: number;
  skipped: number;
}

export interface ExecutorDeps {
  config: WresKeeperConfig;
  etica: EticaClient;
  tron: TronClient;
  log: Logger;
}

export async function executePlan(plan: KeeperPlan, deps: ExecutorDeps): Promise<ExecutionReport> {
  const { config, etica, tron, log } = deps;
  const dry = config.dryRun;
  const tag = dry ? '[dry-run] would' : '[exec]';
  const report: ExecutionReport = { minted: 0, fronted: 0, paid: 0, skipped: 0 };

  // ── 1. Entries: mint twin, then front TRX from the reserve ──────────────
  // The reserve self-limits via `frontableNow` (min of balance and the epoch
  // drip cap); we read it once and debit locally so one tick never over-fronts.
  let frontBudget = plan.entries.some((e) => e.initialFrontSun > 0n)
    ? await tron.frontableNow()
    : 0n;

  for (const entry of plan.entries) {
    try {
      log.info(
        `${tag} mintTwin resTokenId=${entry.resTokenId} ` +
          `recipient=${entry.tronRecipient} payout=${entry.payoutWallet}`,
      );
      if (dry) {
        report.minted += 1;
        if (entry.initialFrontSun > 0n) {
          log.info(`${tag} frontUpgrade ${formatTrx(entry.initialFrontSun)} into new twin`);
        }
        continue;
      }

      const { txid, tokenId } = await tron.mintTwin(
        entry.tronRecipient,
        entry.payoutWallet,
        entry.resTokenId,
      );
      report.minted += 1;
      log.info(`[exec] minted twin tokenId=${tokenId} tx=${txid}`);

      if (entry.initialFrontSun > 0n) {
        if (frontBudget < entry.initialFrontSun) {
          log.warn(
            `[exec] skipping frontUpgrade for twin ${tokenId}: ` +
              `reserve budget ${formatTrx(frontBudget)} < ${formatTrx(entry.initialFrontSun)}`,
          );
        } else {
          const frontTx = await tron.frontUpgrade(tokenId, entry.initialFrontSun);
          frontBudget -= entry.initialFrontSun;
          report.fronted += 1;
          log.info(`[exec] fronted ${formatTrx(entry.initialFrontSun)} into twin ${tokenId} tx=${frontTx}`);
        }
      }
    } catch (err) {
      report.skipped += 1;
      log.error(`[exec] entry resTokenId=${entry.resTokenId} failed: ${errMsg(err)}`);
    }
  }

  // ── 2. Payouts: claim -> topUp -> keeper ops -> mint eTRX -> swap -> holder ─
  for (const payout of plan.payouts) {
    const { tokenId, payoutWallet, split } = payout;
    try {
      log.info(
        `${tag} claimForPayout twin=${tokenId} (${formatTrx(payout.claimableSun)}): ` +
          `topUp ${formatTrx(split.reserveTopUpSun)}, keeper ${formatTrx(split.keeperOpsSun)}, ` +
          `payout ${formatTrx(split.payoutSun)}`,
      );
      if (dry) {
        report.paid += 1;
        continue;
      }

      const { txid, amountSun } = await tron.claimForPayout(tokenId);
      log.info(`[exec] claimed ${formatTrx(amountSun)} from twin ${tokenId} tx=${txid}`);

      // Re-derive the split from the *actual* claimed amount (it may differ
      // slightly from the planned snapshot if revenue accrued mid-tick).
      const reserveTopUpSun = (amountSun * BigInt(config.reserveTopUpBps)) / BPS_DENOMINATOR;
      const keeperOpsSun = (amountSun * BigInt(config.keeperOpsBps)) / BPS_DENOMINATOR;
      const payoutSun = amountSun - reserveTopUpSun - keeperOpsSun;

      if (reserveTopUpSun > 0n) {
        const topUpTx = await tron.topUp(reserveTopUpSun);
        log.info(`[exec] reserve topUp ${formatTrx(reserveTopUpSun)} tx=${topUpTx}`);
      }

      // Keeper ops slice stays as TRX in the keeper's wallet — no tx needed.
      if (keeperOpsSun > 0n) {
        log.info(`[exec] keeper ops retained ${formatTrx(keeperOpsSun)}`);
      }

      if (payoutSun > 0n) {
        await payHolderEtx(deps, payoutWallet, payoutSun);
      }
      report.paid += 1;
    } catch (err) {
      report.skipped += 1;
      log.error(`[exec] payout twin=${tokenId} failed: ${errMsg(err)}`);
    }
  }

  return report;
}

/**
 * Bridge `payoutSun` of claimed TRX into ETX for the holder: mint the matching
 * eTRX (1:1) to the keeper, approve the router, quote the eTRX->ETX route, and
 * swap with a slippage floor, delivering ETX straight to the holder's wallet.
 */
async function payHolderEtx(deps: ExecutorDeps, payoutWallet: string, payoutSun: bigint): Promise<void> {
  const { config, etica, log } = deps;
  const keeper = etica.keeperAddress();
  if (!keeper) throw new Error('no Etica signer — cannot deliver ETX payout');

  const etrxWei = sunToEtrxWei(payoutSun);
  await etica.mintEtrx(keeper, etrxWei);
  await etica.approveEtrx(etrxWei);

  const quotedOut = await etica.quoteEtxOut(etrxWei);
  const minOut = (quotedOut * (BPS_DENOMINATOR - BigInt(config.maxSlippageBps))) / BPS_DENOMINATOR;
  const tx = await etica.swapEtrxForEtx(etrxWei, minOut, payoutWallet as `0x${string}`);
  log.info(
    `[exec] paid holder ${payoutWallet}: swapped ${formatTrx(payoutSun)} -> ` +
      `>=${minOut} ETX (quote ${quotedOut}) tx=${tx}`,
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
