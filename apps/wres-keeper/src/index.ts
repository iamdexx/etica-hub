/**
 * wRES keeper entrypoint — long-running loop.
 *
 * Loads config, builds the keeper, and runs `runTick` every
 * `WRES_POLL_INTERVAL_MS`. Each tick is wrapped so a thrown error logs + alerts
 * but never kills the process; SIGINT/SIGTERM drain the current tick and exit.
 *
 * With no signer keys this boots in DRY-RUN automatically (see config), making
 * `pnpm --filter @etica-hub/wres-keeper keeper` safe to run anywhere.
 */

import { loadConfig } from './config.js';
import { createKeeper, runTick } from './keeper.js';
import { sendTelegramAlert } from './telegram.js';
import { sleep } from './utils.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = console;
  const keeper = createKeeper(config, log);

  log.info(
    `[keeper] starting — mode=${config.dryRun ? 'DRY-RUN' : 'LIVE'} ` +
      `poll=${config.pollIntervalMs}ms etica=${config.eticaRpcUrl} tron=${config.tronRpcUrl}`,
  );
  log.info(
    `[keeper] vault=${config.resLockVault ?? 'unset'} miner=${config.wrappedResMiner ?? 'unset'} ` +
      `reserve=${config.trxReserve ?? 'unset'} etrx=${config.etrx ?? 'unset'} router=${config.dexRouter ?? 'unset'}`,
  );

  let stopping = false;
  const stop = (signal: string): void => {
    log.info(`[keeper] ${signal} received — finishing current tick then exiting`);
    stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    try {
      const report = await runTick(keeper);
      if (report.skipped > 0) {
        await sendTelegramAlert(
          `wRES keeper tick: ${report.skipped} action(s) failed ` +
            `(minted=${report.minted} paid=${report.paid} exited=${report.exited})`,
          { botToken: config.telegramBotToken, chatId: config.telegramChatId, silent: true },
          log,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[keeper] tick threw: ${msg}`);
      await sendTelegramAlert(
        `wRES keeper tick threw: ${msg}`,
        { botToken: config.telegramBotToken, chatId: config.telegramChatId },
        log,
      );
    }
    if (stopping) break;
    await sleep(config.pollIntervalMs);
  }

  log.info('[keeper] stopped');
}

main().catch((err) => {
  console.error('[keeper] fatal:', err);
  process.exitCode = 1;
});
