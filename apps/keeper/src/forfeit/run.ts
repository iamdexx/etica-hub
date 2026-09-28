/**
 * Forfeit sweep — settle abandoned research to the treasury.
 *
 * Flow per run:
 *   1. ask the platform for up to `maxPerRun` signed attestations over
 *      records past the 7-day open-market window;
 *   2. re-check `branchClaimed` on chain (the platform's view can be
 *      stale, and two keepers may race);
 *   3. simulate `claim(payload, sig)` with zero value — the simulation
 *      also tells us the recipient, which MUST be the treasury;
 *   4. submit, wait for the receipt, confirm `ownerOf(tokenId)`;
 *   5. list every treasury-held token that is not yet on the marketplace
 *      (see ./list.ts) — this step runs even when no attestations could
 *      be fetched, so a listing never waits on the platform being up.
 *
 * One record failing never aborts the sweep: every outcome is recorded
 * and the next record is attempted.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ForfeitConfig } from './config.js';
import { autoListTreasuryTokens, type AutoListResult } from './list.js';

export const RESEARCH_NFT_ABI = parseAbi([
  'struct ClaimPayload { string parentGoalTitle; string sequence; string analysis; uint256 score; uint256 iterations; string branchGoalId; address submitter; uint64 expiresAt; uint64 exclusiveUntil; uint64 marketOpenUntil; string parentBranchGoalId; }',
  'function claim(ClaimPayload payload, bytes sig) payable returns (uint256 tokenId)',
  'function branchClaimed(bytes32 branchHash) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

export interface Attestation {
  archiveId: string;
  branchGoalId: string;
  payload: Record<string, string>;
  signature: Hex;
}

export interface AttestationsResponse {
  nftAddress?: string;
  chainId?: number;
  scanned?: number;
  reconciled?: number;
  attestations?: Attestation[];
  reason?: string;
}

export interface ForfeitSettlement {
  archiveId: string;
  branchGoalId: string;
  status: 'settled' | 'would-settle' | 'already-claimed' | 'skipped' | 'error';
  tokenId?: string;
  txHash?: Hex;
  reason?: string;
}

export interface ForfeitRunResult {
  dryRun: boolean;
  fetched: number;
  settled: number;
  results: ForfeitSettlement[];
  /** Marketplace auto-listing outcome; absent when no marketplace is configured. */
  listing?: AutoListResult;
  /** Keeper balance in wei after the run, when a signer is configured. */
  keeperBalanceWei?: bigint;
  error?: string;
}

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

/** Rebuild the typed-data struct viem encodes into calldata. */
export function decodePayload(raw: Record<string, string>): {
  parentGoalTitle: string;
  sequence: string;
  analysis: string;
  score: bigint;
  iterations: bigint;
  branchGoalId: string;
  submitter: Hex;
  expiresAt: bigint;
  exclusiveUntil: bigint;
  marketOpenUntil: bigint;
  parentBranchGoalId: string;
} {
  return {
    parentGoalTitle: raw.parentGoalTitle ?? '',
    sequence: raw.sequence ?? '',
    analysis: raw.analysis ?? '',
    score: BigInt(raw.score ?? '0'),
    iterations: BigInt(raw.iterations ?? '0'),
    branchGoalId: raw.branchGoalId ?? '',
    submitter: (raw.submitter ?? '0x') as Hex,
    expiresAt: BigInt(raw.expiresAt ?? '0'),
    exclusiveUntil: BigInt(raw.exclusiveUntil ?? '0'),
    marketOpenUntil: BigInt(raw.marketOpenUntil ?? '0'),
    parentBranchGoalId: raw.parentBranchGoalId ?? '',
  };
}

/**
 * Reject anything that would not force-mint to the treasury: both windows
 * must already be closed, otherwise the contract mints to `msg.sender` —
 * the keeper — instead of the treasury.
 */
export function forfeitEligibility(
  payload: ReturnType<typeof decodePayload>,
  nowSec: number,
): { ok: true } | { ok: false; reason: string } {
  if (payload.marketOpenUntil >= BigInt(nowSec)) {
    return { ok: false, reason: 'still inside the open-market window' };
  }
  if (payload.expiresAt <= BigInt(nowSec)) {
    return { ok: false, reason: 'attestation expired' };
  }
  if (!payload.branchGoalId || !payload.sequence || !payload.parentGoalTitle) {
    return { ok: false, reason: 'incomplete payload' };
  }
  return { ok: true };
}

/** Custom-error selectors the NFT reverts with, keyed by 4-byte hash. */
const REVERT_SELECTORS: Record<string, string> = {
  '0x8baa579f': 'InvalidSignature',
  '0x716dcc39': 'AttestationExpired',
  '0x16e493f7': 'BranchAlreadyClaimed',
  '0x03903520': 'SubmitterOnlyDuringExclusive',
  '0x392334ed': 'InvalidWindow',
  '0xc5729f17': 'ScoreTooHigh',
  '0xe9a25741': 'EmptyBranchId',
  '0xcf3fa1ed': 'EmptyParentGoal',
  '0x1a9eacab': 'EmptySequence',
  '0xae3d4de5': 'SubmitterZero',
  '0x4033e4e3': 'FeeTransferFailed',
  '0xf0c49d44': 'RefundFailed',
};

/** Name the revert instead of logging "reverted with the following signature:". */
export function revertReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const selector = text.match(/0x[0-9a-fA-F]{8}\b/)?.[0]?.toLowerCase();
  const named = selector ? REVERT_SELECTORS[selector] : undefined;
  return named ? `reverted: ${named}() [${selector}]` : (text.split('\n')[0] ?? text);
}

export async function fetchAttestations(
  config: ForfeitConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<AttestationsResponse> {
  const res = await fetchImpl(`${config.baseUrl}/api/labs/treasury/attestations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.workerToken ? { authorization: `Bearer ${config.workerToken}` } : {}),
    },
    body: JSON.stringify({ max: config.maxPerRun }),
  });
  if (!res.ok) {
    throw new Error(`attestations endpoint returned ${res.status}`);
  }
  return (await res.json()) as AttestationsResponse;
}

interface Clients {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
  account: ReturnType<typeof privateKeyToAccount> | null;
}

export async function runForfeitSweep(
  config: ForfeitConfig,
  opts: { log?: Logger; fetchImpl?: typeof fetch } = {},
): Promise<ForfeitRunResult> {
  const log = opts.log ?? console;
  const chain = defineChain({
    id: config.chainId,
    name: 'Etica',
    nativeCurrency: { name: 'EGAZ', symbol: 'EGAZ', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) }) as PublicClient;
  const account = config.privateKey ? privateKeyToAccount(config.privateKey) : null;
  const walletClient: WalletClient | null =
    account && !config.dryRun
      ? createWalletClient({ account, chain, transport: http(config.rpcUrl) })
      : null;
  if (!config.dryRun && !walletClient) {
    const error = 'live sweep requires a signer key';
    log.error(`[forfeit] ${error}`);
    return { dryRun: config.dryRun, fetched: 0, settled: 0, results: [], error };
  }
  const clients: Clients = { publicClient, walletClient, account };

  const settlement = await settleForfeits(config, clients, log, opts.fetchImpl);

  let listing: AutoListResult | undefined;
  if (config.marketplace) {
    try {
      listing = await autoListTreasuryTokens({
        publicClient,
        walletClient,
        account,
        nft: config.nft,
        marketplace: config.marketplace,
        treasury: config.treasury,
        maxPerRun: config.maxListPerRun,
        dryRun: config.dryRun,
        log,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`[autolist] aborted: ${error}`);
      listing = { supply: 0, treasuryHeld: 0, onMarket: 0, listed: 0, treasuryApproved: false, results: [], error };
    }
  }

  const keeperBalanceWei = account
    ? await publicClient.getBalance({ address: account.address }).catch(() => undefined)
    : undefined;

  log.info(
    `[forfeit] run complete — settled=${settlement.settled} ` +
      `errors=${settlement.results.filter((r) => r.status === 'error').length} ` +
      `alreadyClaimed=${settlement.results.filter((r) => r.status === 'already-claimed').length}` +
      (listing ? ` listed=${listing.listed} onMarket=${listing.onMarket}` : '') +
      (keeperBalanceWei !== undefined
        ? ` keeperBalance=${Number(keeperBalanceWei) / 1e18} EGAZ`
        : ''),
  );

  return {
    ...settlement,
    ...(listing ? { listing } : {}),
    keeperBalanceWei,
    ...(settlement.error || listing?.error
      ? { error: [settlement.error, listing?.error].filter(Boolean).join('; ') }
      : {}),
  };
}

async function settleForfeits(
  config: ForfeitConfig,
  { publicClient, walletClient, account }: Clients,
  log: Logger,
  fetchImpl?: typeof fetch,
): Promise<ForfeitRunResult> {
  let response: AttestationsResponse;
  try {
    response = await fetchAttestations(config, fetchImpl);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`[forfeit] could not fetch attestations: ${error}`);
    return { dryRun: config.dryRun, fetched: 0, settled: 0, results: [], error };
  }

  if (response.reason) log.warn(`[forfeit] platform: ${response.reason}`);
  if (
    response.nftAddress &&
    response.nftAddress.toLowerCase() !== config.nft.toLowerCase()
  ) {
    const error = `attestations are for ${response.nftAddress}, configured NFT is ${config.nft}`;
    log.error(`[forfeit] ${error}`);
    return { dryRun: config.dryRun, fetched: 0, settled: 0, results: [], error };
  }
  if (response.chainId !== undefined && response.chainId !== config.chainId) {
    const error = `attestations are for chain ${response.chainId}, configured chain is ${config.chainId}`;
    log.error(`[forfeit] ${error}`);
    return { dryRun: config.dryRun, fetched: 0, settled: 0, results: [], error };
  }

  const attestations = response.attestations ?? [];
  log.info(
    `[forfeit] fetched=${attestations.length} scanned=${response.scanned ?? 0} ` +
      `reconciled=${response.reconciled ?? 0} dryRun=${config.dryRun}`,
  );

  const results: ForfeitSettlement[] = [];
  const submitted = new Set<string>();
  let settled = 0;

  // The contract compares the windows against `block.timestamp`, which
  // trails wall clock; judging eligibility on the chain's own clock keeps
  // the keeper from submitting a claim the node still reads as exclusive.
  const chainNow = await publicClient
    .getBlock({ blockTag: 'latest' })
    .then((b) => Number(b.timestamp))
    .catch(() => Math.floor(Date.now() / 1000));

  for (const att of attestations) {
    const payload = decodePayload(att.payload);
    const base = { archiveId: att.archiveId, branchGoalId: att.branchGoalId };
    const eligible = forfeitEligibility(payload, chainNow);
    if (!eligible.ok) {
      results.push({ ...base, status: 'skipped', reason: eligible.reason });
      continue;
    }
    if (submitted.has(payload.branchGoalId)) {
      results.push({ ...base, status: 'skipped', reason: 'duplicate branch in this batch' });
      continue;
    }
    submitted.add(payload.branchGoalId);

    try {
      const claimed = await publicClient.readContract({
        address: config.nft,
        abi: RESEARCH_NFT_ABI,
        functionName: 'branchClaimed',
        args: [keccak256(stringToBytes(payload.branchGoalId))],
      });
      if (claimed) {
        results.push({ ...base, status: 'already-claimed' });
        continue;
      }

      const sim = await publicClient.simulateContract({
        address: config.nft,
        abi: RESEARCH_NFT_ABI,
        functionName: 'claim',
        args: [payload, att.signature],
        value: 0n,
        account: account?.address ?? config.treasury,
      });
      const tokenId = sim.result as bigint;

      if (config.dryRun || !walletClient) {
        results.push({ ...base, status: 'would-settle', tokenId: tokenId.toString() });
        continue;
      }

      const txHash = await walletClient.writeContract({ ...sim.request, account: account! });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        results.push({ ...base, status: 'error', txHash, reason: 'transaction reverted' });
        continue;
      }

      const owner = (await publicClient.readContract({
        address: config.nft,
        abi: RESEARCH_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      })) as string;
      if (owner.toLowerCase() !== config.treasury.toLowerCase()) {
        results.push({
          ...base,
          status: 'error',
          txHash,
          tokenId: tokenId.toString(),
          reason: `minted to ${owner}, expected treasury`,
        });
        continue;
      }

      settled += 1;
      results.push({ ...base, status: 'settled', txHash, tokenId: tokenId.toString() });
      log.info(`[forfeit] settled ${att.branchGoalId} → token ${tokenId} (${txHash})`);
    } catch (err) {
      const reason = revertReason(err);
      log.warn(`[forfeit] ${att.branchGoalId}: ${reason}`);
      results.push({ ...base, status: 'error', reason });
    }
  }

  return {
    dryRun: config.dryRun,
    fetched: attestations.length,
    settled,
    results,
  };
}
