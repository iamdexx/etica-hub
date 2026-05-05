/**
 * Claim sanity-check monitor.
 *
 * For each PENDING claim observed on a remote `BridgeMinter`, fetch the
 * corresponding `Deposit` event from `BridgeVault` on Etica and compare:
 *
 *   - existence (the deposit nonce must actually exist on Etica),
 *   - recipient (must match the claim's recipient),
 *   - amount (must match the claim's amount; both are amount-net-of-fee),
 *   - destDomain (must equal the remote's Hyperlane domain).
 *
 * On any mismatch — and especially on a non-existent deposit — the
 * watcher fires a Telegram alert with all the diff fields. The veto
 * decision stays manual: the operator sees the alert and pushes the
 * `vetoClaimManual` button (hardware wallet) within the 48h challenge
 * window. We deliberately do NOT auto-push vetoes from this script,
 * because a compromised watcher key would otherwise become a DoS vector.
 *
 * Cadence on the live workflow is every 5 min. Lookback is bounded by
 * `BRIDGE_SCAN_LOOKBACK_BLOCKS` so re-runs are idempotent.
 */

import {
  createPublicClient,
  http,
  parseEventLogs,
  type Address,
  type PublicClient,
} from 'viem';
import { bridgeMinterAbi, bridgeVaultAbi } from './abi.js';
import { loadWatcherConfig, type RemoteChainConfig, type WatcherConfig } from './config.js';
import { sendTelegramAlert } from './telegram.js';

interface ClaimRecord {
  nonce: `0x${string}`;
  submitter: Address;
  recipient: Address;
  amount: bigint;
  expiresAt: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
}

interface SanityFinding {
  remote: string;
  claim: ClaimRecord;
  reason: string;
  diff?: Record<string, string>;
}

async function recentClaimSubmittedEvents(
  client: PublicClient,
  minter: Address,
  lookback: number,
): Promise<ClaimRecord[]> {
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
  return decoded.map((log) => ({
    nonce: log.args.nonce!,
    submitter: log.args.submitter!,
    recipient: log.args.recipient!,
    amount: BigInt(log.args.amount!),
    expiresAt: BigInt(log.args.expiresAt!),
    txHash: log.transactionHash!,
    blockNumber: log.blockNumber!,
  }));
}

async function isStillPending(
  client: PublicClient,
  minter: Address,
  nonce: `0x${string}`,
): Promise<boolean> {
  const claim = (await client.readContract({
    address: minter,
    abi: bridgeMinterAbi,
    functionName: 'claims',
    args: [nonce],
  })) as readonly [Address, bigint, Address, bigint, bigint, number, number];
  // ClaimState: 0 NONE | 1 RECORDED | 2 PENDING | 3 EXECUTED | 4 VETOED
  return claim[5] === 2;
}

async function findDepositOnEtica(
  client: PublicClient,
  vault: Address,
  nonce: `0x${string}`,
): Promise<{ recipient: Address; amount: bigint; destDomain: number } | undefined> {
  // The full historical lookback could be expensive; we bound it to a
  // generous 1M blocks (~5 weeks at 3-sec slots) which covers any claim
  // submitted within the 48h challenge window with a wide margin.
  const head = await client.getBlockNumber();
  const fromBlock = head > 1_000_000n ? head - 1_000_000n : 0n;
  const events = await client.getContractEvents({
    address: vault,
    abi: bridgeVaultAbi,
    eventName: 'Deposit',
    args: { nonce },
    fromBlock,
    toBlock: head,
  });
  const match = events[0];
  if (!match) return undefined;
  return {
    recipient: match.args.recipient!,
    amount: BigInt(match.args.amountNet!),
    destDomain: Number(match.args.destDomain!),
  };
}

function fmtAmount(wei: bigint): string {
  // ETX is 18-decimal. Coarse human-readable rounding: 4 dp.
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 14n;
  return `${whole}.${frac.toString().padStart(4, '0')} ETX`;
}

async function checkClaim(
  remote: RemoteChainConfig,
  claim: ClaimRecord,
  remoteClient: PublicClient,
  eticaClient: PublicClient,
  vault: Address,
  log: Pick<Console, 'info' | 'warn' | 'error'>,
): Promise<SanityFinding | undefined> {
  const stillPending = await isStillPending(remoteClient, remote.minter, claim.nonce);
  if (!stillPending) {
    log.info(`[monitor] ${remote.name} ${claim.nonce}: not pending — skip`);
    return undefined;
  }

  const deposit = await findDepositOnEtica(eticaClient, vault, claim.nonce);
  if (!deposit) {
    return {
      remote: remote.name,
      claim,
      reason: 'no matching Deposit on Etica',
    };
  }

  const diff: Record<string, string> = {};
  if (deposit.recipient.toLowerCase() !== claim.recipient.toLowerCase()) {
    diff.recipient = `etica=${deposit.recipient} remote=${claim.recipient}`;
  }
  if (deposit.amount !== claim.amount) {
    diff.amount = `etica=${fmtAmount(deposit.amount)} remote=${fmtAmount(claim.amount)}`;
  }
  if (deposit.destDomain !== remote.domain) {
    diff.destDomain = `etica=${deposit.destDomain} expected=${remote.domain}`;
  }

  if (Object.keys(diff).length > 0) {
    return { remote: remote.name, claim, reason: 'Deposit/Claim mismatch', diff };
  }
  return undefined;
}

export async function runMonitor(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<{ checked: number; findings: SanityFinding[] }> {
  const config: WatcherConfig = loadWatcherConfig(env);

  if (config.remotes.length === 0) {
    log.info('[monitor] no remotes configured — set BRIDGE_MINTER_ETH_ADDRESS or BRIDGE_MINTER_BNB_ADDRESS');
    return { checked: 0, findings: [] };
  }
  if (!config.etica.vault) {
    log.info('[monitor] BRIDGE_VAULT_ADDRESS unset — cannot run cross-chain sanity check');
    return { checked: 0, findings: [] };
  }

  const eticaClient = createPublicClient({ transport: http(config.etica.rpcUrl) });
  const findings: SanityFinding[] = [];
  let checked = 0;

  for (const remote of config.remotes) {
    const remoteClient = createPublicClient({ transport: http(remote.rpcUrl) });
    let claims: ClaimRecord[] = [];
    try {
      claims = await recentClaimSubmittedEvents(remoteClient, remote.minter, config.scanLookbackBlocks);
    } catch (err) {
      log.error(`[monitor] ${remote.name}: getLogs failed — ${err}`);
      continue;
    }
    log.info(`[monitor] ${remote.name}: ${claims.length} ClaimSubmitted in last ${config.scanLookbackBlocks} blocks`);
    for (const claim of claims) {
      try {
        const finding = await checkClaim(
          remote,
          claim,
          remoteClient,
          eticaClient,
          config.etica.vault,
          log,
        );
        checked += 1;
        if (finding) findings.push(finding);
      } catch (err) {
        log.error(`[monitor] ${remote.name} ${claim.nonce}: check threw — ${err}`);
      }
    }
  }

  if (findings.length > 0) {
    const lines = findings.map((f) => {
      const head = `<b>${f.remote}</b> nonce=<code>${f.claim.nonce.slice(0, 18)}…</code> ${fmtAmount(f.claim.amount)}`;
      const expiresIn = Number(f.claim.expiresAt) - Math.floor(Date.now() / 1000);
      const expires = expiresIn > 3600
        ? `expires in ${(expiresIn / 3600).toFixed(1)}h`
        : `expires in ${Math.max(0, Math.floor(expiresIn / 60))}m`;
      const diff = f.diff
        ? '\n' + Object.entries(f.diff).map(([k, v]) => `  • ${k}: ${v}`).join('\n')
        : '';
      return `${head}\n  reason: ${f.reason}\n  ${expires}${diff}`;
    });
    await sendTelegramAlert(
      `🚨 <b>Bridge sanity check FAILED</b>\n\n${lines.join('\n\n')}\n\n` +
        `Manual veto window: 48h. Operator action: review on-chain, push <code>vetoClaimManual</code> if fraudulent.`,
      { botToken: config.telegramBotToken, chatId: config.telegramChatId },
      log,
    );
  }
  return { checked, findings };
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/bridge-watcher/src/monitor.ts') ||
    process.argv[1].endsWith('/bridge-watcher/dist/monitor.js'));

if (invokedAsScript) {
  runMonitor()
    .then((r) => {
      console.info(`[monitor] checked=${r.checked} findings=${r.findings.length}`);
      // Findings alert via Telegram but do not red the workflow — we don't
      // want a transient mismatch (e.g. an Etica RPC missing a recent block)
      // to look like infrastructure failure. The Telegram alert is the
      // authoritative signal.
    })
    .catch((err) => {
      console.error('[monitor] fatal:', err);
      process.exit(1);
    });
}
