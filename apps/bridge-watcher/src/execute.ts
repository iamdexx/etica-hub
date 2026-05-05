/**
 * Auto-execute matured legitimate claims.
 *
 * Once a claim's 48h challenge window expires and it is still PENDING,
 * anyone can call `executeClaim(nonce)` to mint wETX to the recipient
 * and refund the bond to the original submitter. This script is the
 * default keeper for that flow — saves end users from paying gas on the
 * destination chain and bounds the time funds are stuck.
 *
 * Crucially, this script ALSO runs the same Etica-side sanity check the
 * monitor performs. If a matured claim does not match its Etica deposit,
 * the script refuses to execute it and instead alerts. After 48h the
 * window has already closed, so a manual veto is no longer possible —
 * the catch is moot at that point — but we still log the mismatch as a
 * post-mortem signal and require operator override to execute it.
 *
 * Cadence on the live workflow is every 30 min. Idempotent: the
 * `executeClaim` call reverts on already-executed claims, so re-runs
 * are safe.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bridgeMinterAbi, bridgeVaultAbi } from './abi.js';
import { loadWatcherConfig, type RemoteChainConfig, type WatcherConfig } from './config.js';
import { sendTelegramAlert } from './telegram.js';

interface ExecuteResult {
  remote: string;
  nonce: `0x${string}`;
  txHash?: `0x${string}`;
  skipped: boolean;
  reason?: string;
}

async function maturedPendingClaims(
  client: PublicClient,
  minter: Address,
  lookback: number,
): Promise<{ nonce: `0x${string}`; recipient: Address; amount: bigint; expiresAt: bigint }[]> {
  const head = await client.getBlockNumber();
  const fromBlock = head > BigInt(lookback) ? head - BigInt(lookback) : 0n;
  const logs = await client.getLogs({
    address: minter,
    fromBlock,
    toBlock: head,
  });
  const decoded = parseEventLogs({
    abi: bridgeMinterAbi,
    eventName: 'ClaimSubmitted',
    logs,
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const candidates = decoded.filter((d) => BigInt(d.args.expiresAt!) <= now);
  const out: { nonce: `0x${string}`; recipient: Address; amount: bigint; expiresAt: bigint }[] = [];
  for (const d of candidates) {
    const claim = (await client.readContract({
      address: minter,
      abi: bridgeMinterAbi,
      functionName: 'claims',
      args: [d.args.nonce!],
    })) as readonly [Address, bigint, Address, bigint, bigint, number, number];
    if (claim[5] !== 2) continue; // not PENDING
    out.push({
      nonce: d.args.nonce!,
      recipient: d.args.recipient!,
      amount: BigInt(d.args.amount!),
      expiresAt: BigInt(d.args.expiresAt!),
    });
  }
  return out;
}

async function depositMatches(
  eticaClient: PublicClient,
  vault: Address,
  remote: RemoteChainConfig,
  nonce: `0x${string}`,
  claimRecipient: Address,
  claimAmount: bigint,
): Promise<boolean> {
  const head = await eticaClient.getBlockNumber();
  const fromBlock = head > 1_000_000n ? head - 1_000_000n : 0n;
  const events = await eticaClient.getContractEvents({
    address: vault,
    abi: bridgeVaultAbi,
    eventName: 'Deposit',
    args: { nonce },
    fromBlock,
    toBlock: head,
  });
  const match = events[0];
  if (!match) return false;
  return (
    match.args.recipient!.toLowerCase() === claimRecipient.toLowerCase() &&
    BigInt(match.args.amountNet!) === claimAmount &&
    Number(match.args.destDomain!) === remote.domain
  );
}

async function executeOnRemote(
  remote: RemoteChainConfig,
  config: WatcherConfig,
  log: Pick<Console, 'info' | 'warn' | 'error'>,
): Promise<ExecuteResult[]> {
  if (!config.executePrivateKey) {
    return [{ remote: remote.name, nonce: '0x', skipped: true, reason: 'BRIDGE_EXECUTE_PRIVATE_KEY unset' }];
  }
  const account = privateKeyToAccount(config.executePrivateKey);
  const transport = http(remote.rpcUrl);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });
  const eticaClient = createPublicClient({ transport: http(config.etica.rpcUrl) });

  const matured = await maturedPendingClaims(publicClient, remote.minter, config.scanLookbackBlocks);
  log.info(`[execute] ${remote.name}: ${matured.length} matured PENDING claims`);

  const results: ExecuteResult[] = [];
  for (const claim of matured) {
    if (config.etica.vault) {
      const ok = await depositMatches(
        eticaClient,
        config.etica.vault,
        remote,
        claim.nonce,
        claim.recipient,
        claim.amount,
      );
      if (!ok) {
        log.error(
          `[execute] ${remote.name} ${claim.nonce}: refusing — Etica Deposit does not match. ` +
            `Operator must execute manually after review.`,
        );
        await sendTelegramAlert(
          `⚠️ <b>Bridge auto-execute refused</b> — matured claim has no matching Etica Deposit.\n\n` +
            `<b>${remote.name}</b> nonce=<code>${claim.nonce.slice(0, 18)}…</code>\n` +
            `recipient=<code>${claim.recipient}</code>\n` +
            `amount=${(Number(claim.amount) / 1e18).toFixed(4)} ETX\n\n` +
            `Window already closed (manual veto no longer possible). Investigate before manual <code>executeClaim</code>.`,
          { botToken: config.telegramBotToken, chatId: config.telegramChatId },
          log,
        );
        results.push({ remote: remote.name, nonce: claim.nonce, skipped: true, reason: 'sanity-check failed' });
        continue;
      }
    }

    try {
      const txHash = await walletClient.writeContract({
        chain: null,
        address: remote.minter,
        abi: bridgeMinterAbi,
        functionName: 'executeClaim',
        args: [claim.nonce],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === 'success') {
        log.info(`[execute] ${remote.name} ${claim.nonce}: tx=${txHash}`);
        results.push({ remote: remote.name, nonce: claim.nonce, skipped: false, txHash });
      } else {
        log.warn(`[execute] ${remote.name} ${claim.nonce}: tx ${txHash} reverted`);
        results.push({
          remote: remote.name,
          nonce: claim.nonce,
          skipped: false,
          txHash,
          reason: 'reverted',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[execute] ${remote.name} ${claim.nonce}: threw — ${message}`);
      results.push({ remote: remote.name, nonce: claim.nonce, skipped: true, reason: message });
    }
  }
  return results;
}

export async function runExecute(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{ submitted: number; refused: number }> {
  const config = loadWatcherConfig(env);

  if (config.remotes.length === 0) {
    log.info('[execute] no remotes configured');
    return { submitted: 0, refused: 0 };
  }
  if (!config.executePrivateKey) {
    log.info('[execute] BRIDGE_EXECUTE_PRIVATE_KEY unset — skipping all remotes');
    return { submitted: 0, refused: 0 };
  }

  let submitted = 0;
  let refused = 0;
  for (const remote of config.remotes) {
    const results = await executeOnRemote(remote, config, log);
    for (const r of results) {
      if (r.txHash && !r.reason) submitted += 1;
      if (r.skipped && r.reason === 'sanity-check failed') refused += 1;
    }
  }
  log.info(`[execute] submitted=${submitted} refused=${refused}`);
  return { submitted, refused };
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/bridge-watcher/src/execute.ts') ||
    process.argv[1].endsWith('/bridge-watcher/dist/execute.js'));

if (invokedAsScript) {
  runExecute()
    .then(() => {
      // Soft-exit zero — execute reverts on already-executed claims are
      // expected and not a workflow failure.
    })
    .catch((err) => {
      console.error('[execute] fatal:', err);
      process.exit(1);
    });
}
