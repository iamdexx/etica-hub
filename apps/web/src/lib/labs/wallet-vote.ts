/**
 * Helpers for verifying EIP-191 wallet signatures + reading the voter's
 * live stETX balance off chain 61803 before recording a moderation vote.
 *
 * Moderation weight is read from the stETX ERC-4626 vault rather than
 * the underlying ETX, so voting rights flow from active staking
 * participation (depositing ETX, holding shares) rather than passive
 * token holding. This keeps the moderation gate on the utility side of
 * any securities analysis.
 *
 * Public so unit tests can import the same `verifyVotePayload` helper
 * that the route handlers use.
 */
import { createPublicClient, getAddress, http, isAddress, verifyMessage, type Address, type PublicClient } from 'viem';
import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';

import {
  MAX_SIG_AGE_MS,
  MIN_VOTE_BALANCE_STETX,
  voteMessage,
  type ModTarget,
} from './moderation-store';

const STETX_DECIMALS = 18n;
const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

let cached: PublicClient | null = null;
function client(): PublicClient {
  if (cached) return cached;
  const url = process.env.ETICA_MAINNET_RPC_URL;
  cached = createPublicClient({
    chain: eticaMainnet,
    transport: url ? http(url) : http(),
  }) as PublicClient;
  return cached;
}

export interface VerifyInput {
  action: 'flag' | 'vouch';
  targetType: ModTarget;
  targetId: string;
  wallet: string;
  reason?: string;
  signature: string;
  issuedAt: number;
}

export type VerifyResult =
  | { ok: true; wallet: Address; balance: bigint }
  | { ok: false; status: number; error: string };

/**
 * Validates the vote signature, age, wallet, and reads the wallet's
 * current stETX balance off chain 61803. Returns the canonical checksum
 * address + balance for use by {@link applyVote}.
 */
export async function verifyVotePayload(input: VerifyInput): Promise<VerifyResult> {
  if (!isAddress(input.wallet)) {
    return { ok: false, status: 400, error: 'Invalid wallet address.' };
  }
  if (typeof input.signature !== 'string' || !input.signature.startsWith('0x')) {
    return { ok: false, status: 400, error: 'Invalid signature.' };
  }
  if (typeof input.issuedAt !== 'number' || !Number.isFinite(input.issuedAt)) {
    return { ok: false, status: 400, error: 'Invalid issuedAt.' };
  }
  const age = Date.now() - input.issuedAt;
  if (age < -60_000 || age > MAX_SIG_AGE_MS) {
    return { ok: false, status: 400, error: 'Signature expired. Re-sign and retry.' };
  }
  const wallet = getAddress(input.wallet);
  const message = voteMessage({
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    issuedAt: input.issuedAt,
  });
  let valid = false;
  try {
    valid = await verifyMessage({
      address: wallet,
      message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: 401, error: 'Signature does not match wallet.' };
  }

  const stetx = DEPLOYMENTS[61803]?.stakedETX as Address | undefined;
  if (!stetx || stetx === '0x0000000000000000000000000000000000000000') {
    return { ok: false, status: 503, error: 'stETX address is not configured.' };
  }
  let balance: bigint;
  try {
    balance = (await client().readContract({
      address: stetx,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [wallet],
    })) as bigint;
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Failed to read stETX balance: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (balance < MIN_VOTE_BALANCE_STETX) {
    return {
      ok: false,
      status: 403,
      error: `Wallet holds ${(balance / 10n ** STETX_DECIMALS).toString()} stETX; moderation requires ≥ ${(MIN_VOTE_BALANCE_STETX / 10n ** STETX_DECIMALS).toString()} stETX. Stake ETX at /stake to earn moderation rights.`,
    };
  }
  return { ok: true, wallet, balance };
}
