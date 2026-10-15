/**
 * EticaSwap Direct watcher: an extra pair of eyes on every window.
 *
 * Each run snapshots the factory and every registered pair, runs the pure
 * checks in checks.ts, posts findings to Telegram and, when it holds the
 * guardian key and a critical invariant broke, calls `pauseSwaps()` on
 * the factory. The guardian can only pause; unpausing is the setter's.
 *
 * State (LP floor per window + last scanned block) lives in a JSON file
 * the workflow commits back to the repo, so "hub LP never decreases" is
 * checked across runs and alerts are not repeated for old swaps.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  type Address,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { directFactoryAbi, erc20Abi, hubPairAbi, metaPairAbi } from './abi.js';
import {
  checkFactory,
  checkGuardianKey,
  checkGaming,
  checkWindow,
  nextState,
  worst,
  type FactorySnapshot,
  type Finding,
  type SwapRecord,
  type WatcherState,
  type WindowSnapshot,
} from './checks.js';
import { fetchUpdates, HELP_TEXT, parseCommands, type Command } from './commands.js';
import { isZeroAddress, loadConfig, type ExpectedSettings, type WatcherConfig } from './config.js';
import { sendTelegramAlert } from './telegram.js';

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[direct-watcher] ignoring unreadable ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

async function snapshotFactory(
  client: PublicClient,
  factory: Address,
  expected: ExpectedSettings,
): Promise<FactorySnapshot> {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: factory, abi: directFactoryAbi, functionName, args } as never) as Promise<T>;
  const [feeTo, feeToSetter, guardian, metaPairDeployer, swapsPaused, pauseExpiresAt, minStEtx, baseFeeBps, tierCount] =
    await Promise.all([
      read<Address>('feeTo'),
      read<Address>('feeToSetter'),
      read<Address>('guardian'),
      read<Address>('metaPairDeployer'),
      read<boolean>('swapsPaused'),
      read<bigint>('pauseExpiresAt'),
      read<bigint>('minStEtx'),
      read<number>('baseFeeBps'),
      read<bigint>('feeTierCount'),
    ]);
  const tiers = await Promise.all(
    Array.from({ length: Number(tierCount) }, (_, i) =>
      read<readonly [bigint, number]>('feeTier', [BigInt(i)]).then(([m, f]) => ({ minStEtx: m, feeBps: f })),
    ),
  );
  const whitelisted: Record<string, boolean> = {};
  for (const a of expected.whitelist ?? []) {
    whitelisted[a.toLowerCase()] = await read<boolean>('whitelist', [a]);
  }
  return {
    feeTo,
    feeToSetter,
    guardian,
    metaPairDeployer,
    swapsPaused,
    pauseExpiresAt: Number(pauseExpiresAt),
    minStEtx,
    baseFeeBps,
    tiers,
    whitelisted,
  };
}

async function snapshotWindow(
  client: PublicClient,
  factory: Address,
  pair: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<WindowSnapshot> {
  const readPair = <T>(functionName: string) =>
    client.readContract({ address: pair, abi: metaPairAbi, functionName } as never) as Promise<T>;
  const [token0, token1, hubPair0, hubPair1, etx, [lp0, lp1], [r0, r1], retired] = await Promise.all([
    readPair<Address>('token0'),
    readPair<Address>('token1'),
    readPair<Address>('hubPair0'),
    readPair<Address>('hubPair1'),
    readPair<Address>('etx'),
    readPair<readonly [bigint, bigint]>('hubLiquidity'),
    readPair<readonly [bigint, bigint]>('liveReserves'),
    client.readContract({ address: factory, abi: directFactoryAbi, functionName: 'retired', args: [pair] }),
  ]);
  const hub = async (hubPair: Address, token: Address) => {
    const [t0, [res0, res1]] = await Promise.all([
      client.readContract({ address: hubPair, abi: hubPairAbi, functionName: 'token0' }),
      client.readContract({ address: hubPair, abi: hubPairAbi, functionName: 'getReserves' }),
    ]);
    return t0.toLowerCase() === token.toLowerCase()
      ? { token: BigInt(res0), etx: BigInt(res1) }
      : { token: BigInt(res1), etx: BigInt(res0) };
  };
  const [h0, h1, loose0, loose1, looseEtx, logs] = await Promise.all([
    hub(hubPair0, token0),
    hub(hubPair1, token1),
    client.readContract({ address: token0, abi: erc20Abi, functionName: 'balanceOf', args: [pair] }),
    client.readContract({ address: token1, abi: erc20Abi, functionName: 'balanceOf', args: [pair] }),
    client.readContract({ address: etx, abi: erc20Abi, functionName: 'balanceOf', args: [pair] }),
    client.getLogs({ address: pair, fromBlock, toBlock }),
  ]);
  // walk Swap and Sync in log order: the Sync preceding a Swap is its pre-trade reserve
  const parsed = parseEventLogs({ abi: metaPairAbi, logs }).sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  const swaps: SwapRecord[] = [];
  let pre: { r0: bigint; r1: bigint } | undefined;
  for (const l of parsed) {
    if (l.eventName === 'Sync') {
      pre = { r0: BigInt(l.args.reserve0), r1: BigInt(l.args.reserve1) };
    } else if (l.eventName === 'Swap') {
      swaps.push({
        amount0In: BigInt(l.args.amount0In),
        amount1In: BigInt(l.args.amount1In),
        amount0Out: BigInt(l.args.amount0Out),
        amount1Out: BigInt(l.args.amount1Out),
        sender: l.args.sender,
        to: l.args.to,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        ...(pre ? { pre } : {}),
      });
    }
  }
  // hub cross price r1/r0 = (h1.token/h1.etx) / (h0.token/h0.etx)
  return {
    pair,
    token0,
    token1,
    retired,
    lp0,
    lp1,
    r0,
    r1,
    hubPriceNum: h1.token * h0.etx,
    hubPriceDen: h1.etx * h0.token,
    loose0,
    loose1,
    looseEtx,
    swaps,
  };
}

async function pauseVenue(cfg: WatcherConfig, chain: ReturnType<typeof defineChain>): Promise<string> {
  if (!cfg.guardianPrivateKey) return 'no guardian key, not pausing';
  const account = privateKeyToAccount(cfg.guardianPrivateKey);
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const hash = await wallet.writeContract({
    chain,
    account,
    address: cfg.factory,
    abi: directFactoryAbi,
    functionName: 'pauseSwaps',
  });
  return `paused swaps via guardian ${account.address}: ${hash}`;
}

function statusText(f: FactorySnapshot, windows: WindowSnapshot[], findings: Finding[], head: bigint): string {
  const lines = [`<b>EticaSwap Direct status</b> (block ${head})`];
  lines.push(
    f.swapsPaused
      ? f.pauseExpiresAt
        ? `⏸ paused by guardian, reopens ${new Date(f.pauseExpiresAt * 1000).toISOString()}`
        : '⏸ paused by the multisig (no expiry)'
      : '▶️ swaps open',
  );
  lines.push(`guardian ${f.guardian}, setter ${f.feeToSetter}, feeTo ${f.feeTo}`);
  lines.push(`gate ${f.minStEtx / 10n ** 18n} stETX, ladder ${f.tiers.map((t) => `${t.minStEtx / 10n ** 18n}:${t.feeBps}bps`).join(' ') || '(none)'}`);
  for (const w of windows) {
    lines.push(
      `• ${w.pair}${w.retired ? ' (retired)' : ''} hub LP ${w.lp0}/${w.lp1}, reserves ${w.r0}/${w.r1}, ${w.swaps.length} swap(s) this scan`,
    );
  }
  lines.push(findings.length ? `${findings.length} finding(s): ${findings.map((x) => x.code).join(', ')}` : 'no findings');
  return lines.join('\n');
}

async function answerCommands(
  cfg: WatcherConfig,
  chain: ReturnType<typeof defineChain>,
  lastUpdateId: number | undefined,
  factorySnap: FactorySnapshot,
  windows: WindowSnapshot[],
  findings: Finding[],
  head: bigint,
): Promise<number | undefined> {
  if (!cfg.telegramBotToken || cfg.telegramAdminIds.length === 0) return lastUpdateId;
  const updates = await fetchUpdates(cfg.telegramBotToken, lastUpdateId);
  if (updates.length === 0) return lastUpdateId;
  const newest = Math.max(...updates.map((u) => u.update_id));
  const commands: Command[] = parseCommands(updates, cfg.telegramAdminIds, cfg.telegramBotName);
  for (const c of commands) {
    let reply: string;
    if (c.name === 'help') reply = HELP_TEXT;
    else if (c.name === 'status') reply = statusText(factorySnap, windows, findings, head);
    else if (factorySnap.swapsPaused) reply = 'already paused';
    else {
      try {
        reply = `${c.fromName} asked for a pause: ${await pauseVenue(cfg, chain)}`;
        factorySnap.swapsPaused = true;
      } catch (err) {
        reply = `pauseSwaps failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    console.info(`[direct-watcher] /${c.name} from ${c.fromName}`);
    await sendTelegramAlert(reply, { botToken: cfg.telegramBotToken, chatId: String(c.chatId), silent: true });
  }
  return newest;
}

function format(findings: Finding[], action?: string): string {
  const icon = { critical: '🚨', warning: '⚠️', info: 'ℹ️' } as const;
  const lines = findings.map((f) => `${icon[f.severity]} <b>${f.code}</b> ${f.message}`);
  if (action) lines.push(`🛑 ${action}`);
  return `<b>EticaSwap Direct watcher</b>\n${lines.join('\n')}`;
}

export async function main(cfg: WatcherConfig = loadConfig()): Promise<number> {
  if (isZeroAddress(cfg.factory)) {
    console.info('[direct-watcher] factory not deployed, skipping');
    return 0;
  }
  const chain = defineChain({
    id: cfg.chainId,
    name: 'Etica',
    nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const expected = readJson<ExpectedSettings>(cfg.expectedPath, {});
  const prev = readJson<WatcherState | undefined>(cfg.statePath, undefined);

  const head = await client.getBlockNumber();
  const lookback = BigInt(cfg.scanLookbackBlocks);
  const floor = head > lookback ? head - lookback : 0n;
  const fromBlock = prev ? (BigInt(prev.lastBlock) + 1n > floor ? BigInt(prev.lastBlock) + 1n : floor) : floor;

  const factorySnap = await snapshotFactory(client, cfg.factory, expected);
  const findings = checkFactory(factorySnap, expected);
  findings.push(
    ...checkGuardianKey(factorySnap, cfg.guardianPrivateKey && privateKeyToAccount(cfg.guardianPrivateKey).address),
  );

  const n = Number(
    await client.readContract({ address: cfg.factory, abi: directFactoryAbi, functionName: 'allPairsLength' }),
  );
  const windows: WindowSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const pair = await client.readContract({
      address: cfg.factory,
      abi: directFactoryAbi,
      functionName: 'allPairs',
      args: [BigInt(i)],
    });
    const isMeta = await client.readContract({
      address: cfg.factory,
      abi: directFactoryAbi,
      functionName: 'isMetaPair',
      args: [pair],
    });
    if (!isMeta) continue;
    const w = await snapshotWindow(client, cfg.factory, pair, fromBlock, head);
    windows.push(w);
    findings.push(...checkWindow(w, prev?.windows[pair.toLowerCase()], cfg.reserveDriftBps, cfg.largeSwapBps));
    findings.push(...checkGaming(w, cfg.priceImpactBps, cfg.roundTripBlocks));
  }

  let action: string | undefined;
  if (worst(findings) === 'critical' && !factorySnap.swapsPaused) {
    try {
      action = await pauseVenue(cfg, chain);
    } catch (err) {
      action = `pauseSwaps failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const state = nextState(windows, prev, head);
  state.lastUpdateId = await answerCommands(cfg, chain, prev?.lastUpdateId, factorySnap, windows, findings, head);
  mkdirSync(dirname(cfg.statePath), { recursive: true });
  writeFileSync(cfg.statePath, JSON.stringify(state, null, 2) + '\n');

  for (const f of findings) console.info(`[direct-watcher] ${f.severity} ${f.code}: ${f.message}`);
  if (action) console.info(`[direct-watcher] ${action}`);
  console.info(`[direct-watcher] ${windows.length} window(s) checked at block ${head}, ${findings.length} finding(s)`);

  const level = worst(findings);
  if (level) {
    await sendTelegramAlert(format(findings, action), {
      botToken: cfg.telegramBotToken,
      chatId: cfg.telegramChatId,
      silent: level === 'info',
    });
  }
  return level === 'critical' ? 1 : 0;
}

if (process.argv[1]?.endsWith('watch.ts') || process.argv[1]?.endsWith('watch.js')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[direct-watcher] run failed:', err);
      process.exit(2);
    });
}
