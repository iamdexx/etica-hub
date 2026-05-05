/**
 * Heartbeat tick — calls `BridgeMinter.heartbeat()` on every configured
 * remote chain so the on-chain `HeartbeatISM` keeps accepting inbound
 * Hyperlane messages.
 *
 * Cadence on the live workflow is every 15 min. The on-chain default
 * `heartbeatTimeout` is 4h, so we have ~16 successful runs of margin
 * before the contract auto-pauses inbound deposits.
 *
 * Behavior:
 *   - Skip cleanly (exit 0) if `BRIDGE_HEARTBEAT_PRIVATE_KEY` is unset.
 *     The bridge isn't deployed yet on first runs and CI must stay green.
 *   - Skip cleanly per-remote if a `BRIDGE_MINTER_*_ADDRESS` is unset.
 *   - On RPC or send failures, alert via Telegram and exit 1 so the
 *     workflow surfaces a red badge.
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bridgeMinterAbi } from './abi.js';
import { loadWatcherConfig, type RemoteChainConfig, type WatcherConfig } from './config.js';
import { sendTelegramAlert } from './telegram.js';

interface TickResult {
  remote: string;
  txHash?: `0x${string}`;
  skipped: boolean;
  error?: string;
}

async function tickRemote(
  remote: RemoteChainConfig,
  config: WatcherConfig,
  log: Pick<Console, 'info' | 'warn' | 'error'>,
): Promise<TickResult> {
  if (!config.heartbeatPrivateKey) {
    log.info(`[heartbeat] ${remote.name}: skip — BRIDGE_HEARTBEAT_PRIVATE_KEY unset`);
    return { remote: remote.name, skipped: true };
  }
  const account = privateKeyToAccount(config.heartbeatPrivateKey);
  const transport = http(remote.rpcUrl);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });

  const expected = await publicClient.readContract({
    address: remote.minter,
    abi: bridgeMinterAbi,
    functionName: 'heartbeatSigner',
  });
  if (expected.toLowerCase() !== account.address.toLowerCase()) {
    const reason =
      `[heartbeat] ${remote.name}: signer mismatch — minter expects ${expected} ` +
      `but watcher EOA is ${account.address}. Update the on-chain heartbeatSigner ` +
      `via the timelocked op or rotate BRIDGE_HEARTBEAT_PRIVATE_KEY.`;
    log.error(reason);
    return { remote: remote.name, skipped: false, error: 'signer-mismatch' };
  }

  const txHash = await walletClient.writeContract({
    chain: null,
    address: remote.minter,
    abi: bridgeMinterAbi,
    functionName: 'heartbeat',
    args: [],
  });
  log.info(`[heartbeat] ${remote.name}: tx=${txHash}`);
  // Wait for inclusion so the workflow surfaces a real revert if any.
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    return { remote: remote.name, skipped: false, txHash, error: `tx reverted (${txHash})` };
  }
  return { remote: remote.name, skipped: false, txHash };
}

export async function runHeartbeat(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{ results: TickResult[]; failures: number }> {
  const config = loadWatcherConfig(env);

  if (config.remotes.length === 0) {
    log.info('[heartbeat] no remotes configured — set BRIDGE_MINTER_ETH_ADDRESS or BRIDGE_MINTER_BNB_ADDRESS');
    return { results: [], failures: 0 };
  }

  const results: TickResult[] = [];
  for (const remote of config.remotes) {
    try {
      results.push(await tickRemote(remote, config, log));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[heartbeat] ${remote.name}: threw — ${message}`);
      results.push({ remote: remote.name, skipped: false, error: message });
    }
  }

  const failures = results.filter((r) => r.error).length;
  if (failures > 0) {
    const summary = results
      .filter((r) => r.error)
      .map((r) => `• <b>${r.remote}</b>: ${r.error}`)
      .join('\n');
    await sendTelegramAlert(
      `🛑 <b>Bridge heartbeat failed</b>\n${summary}\n` +
        `Watcher: GitHub Actions cron (apps/bridge-watcher)`,
      { botToken: config.telegramBotToken, chatId: config.telegramChatId },
      log,
    );
  }
  return { results, failures };
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/bridge-watcher/src/heartbeat.ts') ||
    process.argv[1].endsWith('/bridge-watcher/dist/heartbeat.js'));

if (invokedAsScript) {
  runHeartbeat()
    .then((r) => {
      if (r.failures > 0) process.exit(1);
    })
    .catch((err) => {
      console.error('[heartbeat] fatal:', err);
      process.exit(1);
    });
}
