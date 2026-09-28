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
 *   4. submit, wait for the receipt, confirm `ownerOf(tokenId)`.
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

  let response: AttestationsResponse;
  try {
    response = await fetchAttestations(config, opts.fetchImpl);
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

  const account = config.privateKey ? privateKeyToAccount(config.privateKey) : null;
  const walletClient: WalletClient | null =
    account && !config.dryRun
      ? createWalletClient({ account, chain, transport: http(config.rpcUrl) })
      : null;
  if (!config.dryRun && !walletClient) {
    const error = 'live sweep requires a signer key';
    log.error(`[forfeit] ${error}`);
    return { dryRun: config.dryRun, fetched: attestations.length, settled: 0, results: [], error };
  }

  const results: ForfeitSettlement[] = [];
  let settled = 0;

  for (const att of attestations) {
    const payload = decodePayload(att.payload);
    const base = { archiveId: att.archiveId, branchGoalId: att.branchGoalId };
    const eligible = forfeitEligibility(payload, Math.floor(Date.now() / 1000));
    if (!eligible.ok) {
      results.push({ ...base, status: 'skipped', reason: eligible.reason });
      continue;
    }

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
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      log.warn(`[forfeit] ${att.branchGoalId}: ${reason}`);
      results.push({ ...base, status: 'error', reason });
    }
  }

  const keeperBalanceWei = account
    ? await publicClient.getBalance({ address: account.address }).catch(() => undefined)
    : undefined;

  log.info(
    `[forfeit] run complete — settled=${settled} ` +
      `errors=${results.filter((r) => r.status === 'error').length} ` +
      `alreadyClaimed=${results.filter((r) => r.status === 'already-claimed').length}` +
      (keeperBalanceWei !== undefined
        ? ` keeperBalance=${Number(keeperBalanceWei) / 1e18} EGAZ`
        : ''),
  );

  return {
    dryRun: config.dryRun,
    fetched: attestations.length,
    settled,
    results,
    keeperBalanceWei,
  };
}
