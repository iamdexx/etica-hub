/**
 * Research markets auto-Sourcify worker — single tick.
 *
 * Designed to run as a GitHub Actions cron job (every ~10 min). On each
 * tick we:
 *   1. Read the {EticaResearchMarkets} singleton's `Launched` events from
 *      a sliding window of recent blocks (default last ~50_000 blocks).
 *   2. For each unique ResearchToken address, ask the Sourcify server
 *      whether it's already verified for chain 61803. If yes, skip.
 *   3. Otherwise POST the canonical ResearchToken bundle (committed at
 *      packages/contracts/sourcify-bundles/ResearchToken/) to Sourcify's
 *      /v2/verify/{chainId}/{address} endpoint. The bundle is the same
 *      for every launch because ResearchToken's bytecode is deterministic
 *      across launches (only constructor strings differ), so one canonical
 *      standard-input.json verifies every new token.
 *
 * The worker is fully idempotent: it has no local state. Sourcify itself
 * is the deduplication source — `GET /v2/contract/{chainId}/{address}`
 * tells us whether a given address is already verified.
 *
 * If the EticaResearchMarkets singleton has not yet been deployed (i.e.
 * the address in packages/shared/src/addresses.ts is the zero address),
 * the worker logs a clear message and exits 0. This lets the cron tick
 * before deployment without spamming failures.
 *
 * If Etica is not yet supported by the public Sourcify instance, the
 * verify POST will return 4xx. We log the response body and exit 0 —
 * a chain-add PR on argotorg/sourcify is the user-facing fix, and the
 * worker will start producing successful verifications the moment that
 * lands. (See docs/SOURCIFY_CHAIN_SUBMISSION.md.)
 *
 * Env:
 *   RESEARCH_SOURCIFY_RPC_URL    — Etica mainnet RPC, e.g.
 *                                  https://rpc2.etica-stats.org
 *   RESEARCH_SOURCIFY_SERVER     — defaults to https://sourcify.dev/server
 *   RESEARCH_SOURCIFY_CHAIN_ID   — defaults to 61803
 *   RESEARCH_SOURCIFY_LOOKBACK   — block lookback window, defaults to
 *                                  50_000 (~7d at 12s blocks)
 *   RESEARCH_SOURCIFY_BUNDLE_DIR — path to sourcify-bundles/ResearchToken/.
 *                                  Defaults to a path relative to this
 *                                  file, resolved at runtime.
 *   RESEARCH_SOURCIFY_SINGLETON  — manual override of the singleton
 *                                  address (skips addresses.ts lookup).
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { researchMarketsSingleton } from './addresses.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const CHAIN_ID = Number(process.env.RESEARCH_SOURCIFY_CHAIN_ID || 61803);
const SOURCIFY_SERVER = (
  process.env.RESEARCH_SOURCIFY_SERVER || 'https://sourcify.dev/server'
).replace(/\/$/, '');
const RPC_URL = process.env.RESEARCH_SOURCIFY_RPC_URL || '';
const LOOKBACK = Number(process.env.RESEARCH_SOURCIFY_LOOKBACK || 50_000);

// The packaged bundle ships at
//   packages/contracts/sourcify-bundles/ResearchToken/
// relative to the repo root. The worker resolves to it from
// apps/research-markets-sourcify/dist/ (when compiled) or
// apps/research-markets-sourcify/src/ (under tsx). Both layouts are 3
// levels deep from the repo root, so `../../../packages/...` is correct.
const DEFAULT_BUNDLE_DIR = resolvePath(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'contracts',
  'sourcify-bundles',
  'ResearchToken',
);
const BUNDLE_DIR = process.env.RESEARCH_SOURCIFY_BUNDLE_DIR || DEFAULT_BUNDLE_DIR;

// Singleton emits this when a researcher calls launch(...). We only need
// the token field to know which contract to verify, but viem requires
// the full topic abi for indexed-arg decoding.
const LAUNCHED_ABI = parseAbi([
  'event Launched(address indexed token, address indexed researcher, uint256 virtualEtxStart, uint256 virtualTokenStart, uint256 launchToll)',
]);

type Bundle = {
  standardInput: unknown;
  contractIdentifier: string;
  compilerVersion: string;
};

function loadBundle(): Bundle {
  const stdInputPath = resolvePath(BUNDLE_DIR, 'standard-input.json');
  const infoPath = resolvePath(BUNDLE_DIR, 'info.json');
  const standardInput = JSON.parse(readFileSync(stdInputPath, 'utf8'));
  const info = JSON.parse(readFileSync(infoPath, 'utf8')) as {
    contractIdentifier: string;
    compilerVersion: string;
  };
  return {
    standardInput,
    contractIdentifier: info.contractIdentifier,
    compilerVersion: info.compilerVersion,
  };
}

function makeClient(): PublicClient {
  if (!RPC_URL) {
    throw new Error('RESEARCH_SOURCIFY_RPC_URL is required');
  }
  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Etica',
    nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
  });
  return createPublicClient({ chain, transport: http(RPC_URL) });
}

async function fetchLaunchedTokens(
  client: PublicClient,
  singleton: Address,
): Promise<Address[]> {
  const head = await client.getBlockNumber();
  const from = head > BigInt(LOOKBACK) ? head - BigInt(LOOKBACK) : 0n;
  // viem's getLogs accepts a topic-decoded event spec; this matches all
  // Launched events emitted by the singleton over the window.
  const logs = await client.getLogs({
    address: singleton,
    event: LAUNCHED_ABI[0],
    fromBlock: from,
    toBlock: head,
  });
  const tokens = new Set<Address>();
  for (const log of logs) {
    const tok = (log.args as { token?: Address }).token;
    if (tok && isAddress(tok)) tokens.add(tok);
  }
  return [...tokens];
}

type SourcifyStatus =
  | { kind: 'verified'; match: 'exact' | 'match' | 'unknown' }
  | { kind: 'unverified' }
  | { kind: 'unsupported'; body: unknown }
  | { kind: 'error'; status: number; body: unknown };

async function checkSourcifyStatus(token: Address): Promise<SourcifyStatus> {
  const url = `${SOURCIFY_SERVER}/v2/contract/${CHAIN_ID}/${token}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return { kind: 'unverified' };
  if (res.status === 400 || res.status === 422 || res.status === 501) {
    // Sourcify returns 4xx/501 for unsupported chains.
    return { kind: 'unsupported', body: await res.json().catch(() => null) };
  }
  if (!res.ok) {
    return { kind: 'error', status: res.status, body: await res.json().catch(() => null) };
  }
  const body = (await res.json().catch(() => null)) as
    | { match?: string; runtimeMatch?: string; creationMatch?: string }
    | null;
  const m =
    body?.match ??
    body?.runtimeMatch ??
    body?.creationMatch ??
    'unknown';
  return {
    kind: 'verified',
    match: m === 'exact_match' || m === 'perfect' ? 'exact' : m === 'unknown' ? 'unknown' : 'match',
  };
}

type SubmitResult =
  | { kind: 'submitted'; verificationId?: string; body: unknown }
  | { kind: 'unsupported'; body: unknown }
  | { kind: 'error'; status: number; body: unknown };

async function submitToSourcify(token: Address, bundle: Bundle): Promise<SubmitResult> {
  const url = `${SOURCIFY_SERVER}/v2/verify/${CHAIN_ID}/${token}`;
  const payload = {
    stdJsonInput: bundle.standardInput,
    compilerVersion: bundle.compilerVersion,
    contractIdentifier: bundle.contractIdentifier,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  if (res.status === 400 || res.status === 422 || res.status === 501) {
    return { kind: 'unsupported', body };
  }
  if (!res.ok) return { kind: 'error', status: res.status, body };
  const verificationId =
    body && typeof body === 'object' && 'verificationId' in body
      ? String((body as { verificationId: unknown }).verificationId)
      : undefined;
  return { kind: 'submitted', verificationId, body };
}

async function main() {
  const singleton = process.env.RESEARCH_SOURCIFY_SINGLETON || researchMarketsSingleton(CHAIN_ID);
  if (
    !singleton ||
    !isAddress(singleton) ||
    /^0x0+$/i.test(singleton)
  ) {
    console.log(
      `EticaResearchMarkets singleton is unset for chain ${CHAIN_ID} ` +
        `(addresses.ts has the zero address). Exiting clean — auto-Sourcify ` +
        `will pick up once the singleton is deployed.`,
    );
    return;
  }

  const bundle = loadBundle();
  console.log(`bundle: ${bundle.contractIdentifier} (solc ${bundle.compilerVersion})`);
  console.log(`singleton: ${singleton}`);
  console.log(`sourcify: ${SOURCIFY_SERVER}`);
  console.log(`chain:    ${CHAIN_ID}`);

  const client = makeClient();
  const tokens = await fetchLaunchedTokens(client, singleton as Address);
  console.log(`launched-tokens (lookback ${LOOKBACK}): ${tokens.length}`);

  let verified = 0;
  let alreadyVerified = 0;
  let unsupported = 0;
  let errored = 0;

  for (const token of tokens) {
    const status = await checkSourcifyStatus(token);
    if (status.kind === 'verified') {
      console.log(`  [skip] ${token} already verified (${status.match})`);
      alreadyVerified += 1;
      continue;
    }
    if (status.kind === 'unsupported') {
      console.log(
        `  [skip-all] chain ${CHAIN_ID} appears unsupported by ${SOURCIFY_SERVER}; ` +
          `aborting tick. Body:`,
        status.body,
      );
      unsupported = tokens.length - (verified + alreadyVerified + errored);
      break;
    }
    if (status.kind === 'error') {
      console.error(`  [check-fail] ${token} status=${status.status}`, status.body);
      errored += 1;
      continue;
    }

    // status.kind === 'unverified'
    const submit = await submitToSourcify(token as Address, bundle);
    if (submit.kind === 'submitted') {
      console.log(
        `  [submit] ${token} OK${submit.verificationId ? ` (verificationId=${submit.verificationId})` : ''}`,
      );
      verified += 1;
    } else if (submit.kind === 'unsupported') {
      console.log(
        `  [skip-all] chain ${CHAIN_ID} unsupported on submit; aborting tick.`,
        submit.body,
      );
      unsupported = tokens.length - (verified + alreadyVerified + errored);
      break;
    } else {
      console.error(`  [submit-fail] ${token} status=${submit.status}`, submit.body);
      errored += 1;
    }
  }

  console.log(
    `done: submitted=${verified}, already=${alreadyVerified}, errored=${errored}, unsupported=${unsupported}`,
  );
}

main().catch((err) => {
  console.error('auto-sourcify worker crashed:', err);
  process.exit(1);
});
