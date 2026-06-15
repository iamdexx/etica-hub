import 'server-only';

import {
  createWalletClient,
  http,
  keccak256,
  stringToBytes,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { DEPLOYMENTS, TREASURY_ADDRESS, eticaMainnet } from '@etica-hub/shared';
import eticaResearchNftArtifact from '@/lib/etica-research-nft-artifact.json';
import { getResearchClient } from '@/lib/research';
import { listExpiredUnminted, markAsMinted } from '@/lib/labs/archive';
import type { ArchivedResearch } from '@/lib/labs/archive';
import { discoveryBranchId, parentDiscoveryBranchId } from '@/lib/labs/discovery-id';

/**
 * Server-side treasury crank (Option A).
 *
 * Settles "abandoned" research records — those past the 7-day open-market
 * window that nobody minted — by force-minting them to the treasury via
 * {@link EticaResearchNFT.claim}. Because the contract waives the mint fee
 * whenever the recipient resolves to the treasury (tier-3 path), the only
 * cost is gas, paid by the keeper wallet — never by the user whose mint
 * triggered the crank.
 *
 * Triggering: fired fire-and-forget on every platform mint (the user's own
 * mint is just the signal; this runs as a separate transaction) and as a
 * safety-net pass on the autopilot tick. It is idempotent and bounded:
 *   - at most {@link DEFAULT_MAX_PER_RUN} records are settled per call, so a
 *     backlog can never balloon one trigger into an unbounded gas spend;
 *   - on-chain `branchClaimed` is the authoritative dedupe, so a record can
 *     never be minted twice even if two triggers race.
 *
 * This never throws — protein research must "never fail on anything". All
 * failures are caught and surfaced in the returned summary.
 */

/** 7-day open-market window; matches /api/labs/mint/attest. */
const MARKET_OPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on records settled per crank invocation. */
const DEFAULT_MAX_PER_RUN = 3;
/** How many of the oldest archive entries to scan per run. */
const SCAN_LIMIT = 50;

const CLAIM_TYPES = {
  ClaimPayload: [
    { name: 'parentGoalTitle', type: 'string' },
    { name: 'sequence', type: 'string' },
    { name: 'analysis', type: 'string' },
    { name: 'score', type: 'uint256' },
    { name: 'iterations', type: 'uint256' },
    { name: 'branchGoalId', type: 'string' },
    { name: 'submitter', type: 'address' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'exclusiveUntil', type: 'uint64' },
    { name: 'marketOpenUntil', type: 'uint64' },
    { name: 'parentBranchGoalId', type: 'string' },
  ],
} as const;

export interface CrankSettlement {
  archiveId: string;
  branchGoalId: string;
  txHash?: Hex;
  status: 'settled' | 'already-claimed' | 'skipped' | 'error';
  reason?: string;
}

export interface CrankSummary {
  ran: boolean;
  scanned: number;
  settled: number;
  results: CrankSettlement[];
  reason?: string;
}

function normalisePrivateKey(raw: string | undefined): Hex | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) return null;
  return `0x${hex}` as Hex;
}

function isAddress(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function clampScoreBasisPoints(score: number | undefined): bigint {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0n;
  const bps = Math.round(score * 10_000);
  if (bps < 0) return 0n;
  if (bps > 10_000) return 10_000n;
  return BigInt(bps);
}

/**
 * Run one bounded crank pass. Safe to call concurrently — the on-chain
 * `branchClaimed` guard makes settlement idempotent.
 */
export async function runTreasuryCrank(
  opts: { max?: number } = {},
): Promise<CrankSummary> {
  const max = Math.max(1, Math.min(opts.max ?? DEFAULT_MAX_PER_RUN, 10));
  const empty: CrankSummary = { ran: false, scanned: 0, settled: 0, results: [] };

  try {
    const chainId = eticaMainnet.id;
    const nftAddress = DEPLOYMENTS[chainId].eticaResearchNft;
    if (!isAddress(nftAddress) || /^0x0+$/.test(nftAddress)) {
      return { ...empty, reason: 'EticaResearchNFT not deployed' };
    }

    // The crank submits txs (and pays gas) from the keeper wallet; the
    // attestor key authorises the mint via its EIP-712 signature. They may
    // be the same wallet — LABS_KEEPER_PRIVATE_KEY falls back to the
    // attestor key when no dedicated keeper is provisioned.
    const attestorKey = normalisePrivateKey(process.env.LABS_ATTESTOR_PRIVATE_KEY);
    if (!attestorKey) return { ...empty, reason: 'attestor key not configured' };
    const keeperKey =
      normalisePrivateKey(process.env.LABS_KEEPER_PRIVATE_KEY) ?? attestorKey;

    const cutoffMs = Date.now() - MARKET_OPEN_WINDOW_MS;
    const expired = await listExpiredUnminted(cutoffMs, SCAN_LIMIT);
    if (expired.length === 0) {
      return { ran: true, scanned: 0, settled: 0, results: [] };
    }

    const publicClient = getResearchClient();
    const attestor = privateKeyToAccount(attestorKey);
    const keeper = privateKeyToAccount(keeperKey);
    const rpcUrl = process.env.ETICA_MAINNET_RPC_URL;
    const walletClient = createWalletClient({
      account: keeper,
      chain: eticaMainnet,
      transport: rpcUrl ? http(rpcUrl) : http(),
    });

    const results: CrankSettlement[] = [];
    let settled = 0;

    for (const entry of expired) {
      if (settled >= max) break;
      const result = await settleOne(entry, {
        nftAddress,
        chainId,
        attestor,
        publicClient,
        walletClient,
      });
      results.push(result);
      if (result.status === 'settled') settled += 1;
    }

    return { ran: true, scanned: expired.length, settled, results };
  } catch (err) {
    return { ...empty, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function settleOne(
  entry: ArchivedResearch,
  ctx: {
    nftAddress: Hex;
    chainId: number;
    attestor: ReturnType<typeof privateKeyToAccount>;
    publicClient: ReturnType<typeof getResearchClient>;
    walletClient: ReturnType<typeof createWalletClient>;
  },
): Promise<CrankSettlement> {
  const goalId = entry.goalId;
  if (!goalId) {
    return { archiveId: entry.id, branchGoalId: '', status: 'skipped', reason: 'no goalId' };
  }
  const sequence = entry.bestCandidate?.sequence;
  if (!sequence) {
    return { archiveId: entry.id, branchGoalId: goalId, status: 'skipped', reason: 'no sequence' };
  }
  // Force-mint the best candidate under its per-candidate branch id, matching
  // the user-mint attest scheme so the on-chain dedupe stays consistent.
  const branchGoalId = discoveryBranchId(goalId, entry.bestCandidate.index);

  try {
    const isClaimed = async (id: string): Promise<boolean> =>
      (await ctx.publicClient.readContract({
        abi: eticaResearchNftArtifact.abi,
        address: ctx.nftAddress,
        functionName: 'branchClaimed',
        args: [keccak256(stringToBytes(id))],
      })) as boolean;
    // Dedupe against both the per-candidate id and the legacy bare goal id, so
    // records minted before per-candidate ids are never force-minted twice.
    const [claimed, legacyClaimed] = await Promise.all([
      isClaimed(branchGoalId),
      isClaimed(goalId),
    ]);
    if (claimed || legacyClaimed) {
      // Already settled on chain (by an open-market mint or a prior crank).
      // Reconcile the local archive flag so we stop re-scanning it.
      await markAsMinted(entry.id, '').catch(() => {});
      return { archiveId: entry.id, branchGoalId, status: 'already-claimed' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    // Both windows in the past so the contract resolves the recipient to the
    // treasury (tier 3) and waives the fee. expiresAt is well in the future
    // so the attestation itself is still valid.
    const payload = {
      parentGoalTitle: entry.goalTitle || entry.prompt || `Research ${branchGoalId}`,
      sequence,
      analysis: entry.bestCandidate?.analysis || entry.summary || '',
      score: clampScoreBasisPoints(entry.bestCandidate?.score),
      iterations: BigInt(entry.iterations ?? 0),
      branchGoalId,
      submitter: isAddress(entry.submitterWallet) ? entry.submitterWallet : TREASURY_ADDRESS,
      expiresAt: BigInt(nowSec + 24 * 60 * 60),
      exclusiveUntil: BigInt(nowSec - 2),
      marketOpenUntil: BigInt(nowSec - 1),
      parentBranchGoalId: parentDiscoveryBranchId(entry.parentGoalId, entry.parentCandidateIndex),
    } as const;

    const signature = await ctx.attestor.signTypedData({
      domain: {
        name: 'EticaResearchNFT',
        version: '1',
        chainId: ctx.chainId,
        verifyingContract: ctx.nftAddress,
      },
      types: CLAIM_TYPES,
      primaryType: 'ClaimPayload',
      message: payload,
    });

    const txHash = await ctx.walletClient.writeContract({
      abi: eticaResearchNftArtifact.abi,
      address: ctx.nftAddress,
      functionName: 'claim',
      args: [payload, signature],
      value: 0n,
      chain: eticaMainnet,
      account: ctx.walletClient.account!,
    });

    await markAsMinted(entry.id, txHash).catch(() => {});
    return { archiveId: entry.id, branchGoalId, txHash, status: 'settled' };
  } catch (err) {
    return {
      archiveId: entry.id,
      branchGoalId,
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
